/**
 * Adaptador de Open Interpreter (ejecutor de código y QA).
 *
 * Existen dos "Open Interpreter" distintos y este adaptador soporta ambos,
 * detectando automáticamente cuál está instalado:
 *
 *  1. Paquete Python `open-interpreter` (0.4.x, `pip install open-interpreter`).
 *     Su CLI `--stdin` solo lee UNA línea, así que se usa a través del runner
 *     `src/scripts/interpreter_runner.py`, que llama a `interpreter.chat()` en
 *     streaming con `auto_run=True`: el progreso (código y salida de consola)
 *     sale por stderr según ocurre y el resultado final como JSON por stdout.
 *     Verificado con open-interpreter 0.4.3.
 *
 *  2. Binario nuevo (reescrito en Rust sobre Codex, instalador oficial de
 *     openinterpreter.com). Expone `interpreter exec` para uso no interactivo;
 *     el prompt entra por stdin (`-`) y la respuesta final sale por stdout.
 *     Basado en la documentación oficial; no verificado en este entorno.
 *
 *  3. Si no hay ninguno, MODO FALLBACK: ejecuta localmente los comandos de
 *     verificación que el equipo haya propuesto en bloques ```bash (lista
 *     blanca de herramientas de test/build), para que el ciclo siga aportando
 *     validación real aunque no haya un LLM detrás.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { AdapterStatus, AgentAdapter, AgentTask } from '../types';
import { AppConfig } from '../config';
import { CommandNotFoundError, RunResult, run, truncateMiddle } from '../utils/shell';
import { createLogger } from '../utils/logger';

const log = createLogger('Interpreter');

type InterpreterConfig = AppConfig['interpreter'];

type Backend =
  | { kind: 'python'; python: string; runner: string; version: string }
  | { kind: 'cli'; command: string; version: string }
  | { kind: 'fallback'; reason: string };

/** Comandos que el modo fallback está autorizado a ejecutar (primera palabra). */
const ALLOWED_FALLBACK_COMMANDS = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'node', 'tsc',
  'python', 'python3', 'pytest', 'pip',
  'go', 'cargo', 'make', 'dotnet', 'mvn', 'gradle',
  'ls', 'dir', 'cat', 'git'
]);

/** Subcomandos de git permitidos en fallback (solo lectura). */
const ALLOWED_GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'branch', 'show']);

const MAX_FALLBACK_COMMANDS = 5;
const MAX_ANSWER_CHARS = 12_000;
const BACKEND_CACHE_TTL_MS = 60_000;

export class InterpreterAdapter implements AgentAdapter {
  private cachedBackend?: { value: Backend; at: number };

  constructor(private readonly config: InterpreterConfig) {}

  getSourceBackend(): string {
    return `Open Interpreter · ${this.config.model || 'modelo configurado'}`;
  }

  async getStatus(): Promise<AdapterStatus> {
    const backend = await this.detectBackend();
    switch (backend.kind) {
      case 'python':
        return { available: true, mode: 'python', detail: `open-interpreter ${backend.version} (${backend.python})` };
      case 'cli':
        return { available: true, mode: 'cli', detail: backend.version };
      case 'fallback':
        return { available: true, mode: 'fallback', detail: `${backend.reason}: se ejecutarán solo los comandos de verificación propuestos en el chat` };
    }
  }

  async sendMessage(task: AgentTask): Promise<string> {
    const backend = await this.detectBackend();
    switch (backend.kind) {
      case 'python':
        return this.runPythonRunner(task, backend);
      case 'cli':
        return this.runExecCli(task, backend);
      case 'fallback':
        return this.runFallback(task);
    }
  }

  // ---------------------------------------------------------------------------
  // Detección del backend
  // ---------------------------------------------------------------------------

  /**
   * Orden de preferencia: paquete Python (comprobado con el runner `--check`)
   * → binario nuevo (`interpreter --version` sin "Developer Preview") → fallback.
   */
  private async detectBackend(): Promise<Backend> {
    const now = Date.now();
    if (this.cachedBackend && now - this.cachedBackend.at < BACKEND_CACHE_TTL_MS) {
      return this.cachedBackend.value;
    }

    const value = await this.probeBackend();
    this.cachedBackend = { value, at: now };
    return value;
  }

  private async probeBackend(): Promise<Backend> {
    const runner = resolveRunnerPath();
    const python = this.config.python;

    if (runner) {
      try {
        const result = await run(python, [runner, '--check'], { timeoutMs: 30_000 });
        if (result.exitCode === 0) {
          const info = JSON.parse(result.stdout.trim().split('\n').pop() ?? '{}') as { version?: string };
          return { kind: 'python', python, runner, version: info.version ?? '?' };
        }
      } catch (err) {
        if (!(err instanceof CommandNotFoundError)) log.warn('fallo al comprobar el paquete Python', err as Error);
      }
    }

    try {
      const result = await run(this.config.command, ['--version'], { timeoutMs: 15_000 });
      const version = (result.stdout || result.stderr).trim().split('\n')[0];
      // El paquete Python clásico también responde a `interpreter --version`,
      // pero su CLI no sirve para prompts multilínea; solo aceptamos el binario nuevo.
      if (result.exitCode === 0 && version && !/Developer Preview/i.test(version)) {
        return { kind: 'cli', command: this.config.command, version };
      }
      if (result.exitCode === 0) {
        return { kind: 'fallback', reason: `"${this.config.command}" es el paquete Python pero falta el runner o \`${python}\` no lo tiene instalado` };
      }
    } catch {
      // no instalado
    }

    return { kind: 'fallback', reason: `Open Interpreter no instalado (ni paquete Python en \`${python}\` ni binario \`${this.config.command}\`)` };
  }

  // ---------------------------------------------------------------------------
  // Backend 1: paquete Python vía runner
  // ---------------------------------------------------------------------------

  private async runPythonRunner(task: AgentTask, backend: Extract<Backend, { kind: 'python' }>): Promise<string> {
    const args = [backend.runner];
    if (this.config.model) args.push('--model', this.config.model);
    if (this.config.apiBase) args.push('--api-base', this.config.apiBase);
    if (this.config.apiKey) args.push('--api-key', this.config.apiKey);
    args.push('--context-window', String(this.config.contextWindow), '--max-tokens', String(this.config.maxTokens));

    const result = await run(backend.python, args, {
      cwd: task.projectPath,
      input: task.prompt,
      timeoutMs: this.config.timeoutMs,
      signal: task.signal,
      // El runner manda a stderr todo lo que Open Interpreter imprime (código, salidas); sirve como progreso.
      onOutput: task.onProgress ? (chunk, stream) => { if (stream === 'stderr') task.onProgress!(chunk); } : undefined
    });

    const header = this.header(task, `${backend.python} interpreter_runner.py`, result);
    if (result.aborted) {
      return header + `⏹️ **Turno detenido por el usuario.**` + tail(result.stderr);
    }
    if (result.timedOut) {
      return header + `⏱️ **Tiempo agotado** tras ${this.config.timeoutMs / 1000} s.` + tail(result.stderr);
    }

    const parsed = parseRunnerOutput(result.stdout);
    if (!parsed) {
      return header + `⚠️ **El runner no devolvió JSON** (código ${result.exitCode}).` + tail(result.stderr || result.stdout);
    }
    if (parsed.error) {
      return header + `⚠️ **Error de Open Interpreter:** ${parsed.error}`;
    }
    return header + truncateMiddle(formatRunnerMessages(parsed.messages ?? []), MAX_ANSWER_CHARS);
  }

  // ---------------------------------------------------------------------------
  // Backend 2: binario nuevo (`interpreter exec`)
  // ---------------------------------------------------------------------------

  private async runExecCli(task: AgentTask, backend: Extract<Backend, { kind: 'cli' }>): Promise<string> {
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'workspace-write', '--ask-for-approval', 'never'];
    if (this.config.model) args.push('--model', this.config.model);
    args.push('-'); // prompt por stdin

    const result = await run(backend.command, args, {
      cwd: task.projectPath,
      input: task.prompt,
      timeoutMs: this.config.timeoutMs,
      signal: task.signal,
      onOutput: task.onProgress ? (chunk) => task.onProgress!(chunk) : undefined
    });

    const header = this.header(task, `${backend.command} ${args.join(' ')}`, result);
    if (result.aborted) {
      return header + `⏹️ **Turno detenido por el usuario.**` + tail(result.stdout || result.stderr);
    }
    if (result.timedOut) {
      return header + `⏱️ **Tiempo agotado** tras ${this.config.timeoutMs / 1000} s.` + tail(result.stdout || result.stderr);
    }
    if (result.exitCode !== 0) {
      return header + `⚠️ **El proceso terminó con error.**` + tail(result.stderr || result.stdout);
    }
    const answer = result.stdout.trim();
    return header + (answer ? truncateMiddle(answer, MAX_ANSWER_CHARS) : '_(Open Interpreter terminó sin texto de respuesta.)_');
  }

  // ---------------------------------------------------------------------------
  // Backend 3: fallback sin LLM
  // ---------------------------------------------------------------------------

  private async runFallback(task: AgentTask): Promise<string> {
    const commands = extractVerificationCommands(task.prompt);
    const header = `_**Modo verificación local:** Open Interpreter no está instalado; se ejecutan únicamente los comandos de prueba/build propuestos por el equipo._\n\n` +
      `- **Workspace:** \`${task.projectPath}\`\n\n`;

    if (!commands.length) {
      return header +
        `ℹ️ No se encontraron comandos ejecutables en el último mensaje. ` +
        `Para que este agente valide algo, el desarrollador debe incluir un bloque \`\`\`bash con comandos como \`npm test\`, \`pytest\` o \`npm run build\`.`;
    }

    const reports: string[] = [];
    let failures = 0;

    for (const command of commands) {
      if (task.signal?.aborted) {
        reports.push('⏹️ _Detenido por el usuario antes de ejecutar el resto de comandos._');
        break;
      }
      const [bin, ...args] = command.split(/\s+/);
      task.onProgress?.(`$ ${command}\n`);
      const result = await run(bin, args, {
        cwd: task.projectPath,
        timeoutMs: Math.min(this.config.timeoutMs, 120_000),
        signal: task.signal,
        onOutput: task.onProgress ? (chunk) => task.onProgress!(chunk) : undefined
      }).catch((err: Error) => ({ stdout: '', stderr: err.message, exitCode: 127, timedOut: false, aborted: false, durationMs: 0 } as RunResult));

      const ok = result.exitCode === 0 && !result.timedOut && !result.aborted;
      if (!ok) failures++;

      const output = truncateMiddle((result.stdout + (result.stderr ? '\n' + result.stderr : '')).trim() || '(sin salida)', 3000);
      reports.push(
        `#### ${ok ? '✅' : '❌'} \`${command}\` — código ${result.exitCode ?? 'timeout'} · ${(result.durationMs / 1000).toFixed(1)} s\n` +
        '```text\n' + output + '\n```'
      );
    }

    const summary = failures === 0
      ? `**Resultado: ✅ ${commands.length}/${commands.length} comandos correctos.**`
      : `**Resultado: ❌ ${failures} de ${commands.length} comandos fallaron. Requiere corrección del desarrollador.**`;

    return header + reports.join('\n\n') + '\n\n' + summary;
  }

  // ---------------------------------------------------------------------------

  private header(task: AgentTask, command: string, result: RunResult): string {
    return `- **Comando:** \`${command}\`\n` +
      `- **Workspace:** \`${task.projectPath}\`\n` +
      `- **Duración:** ${(result.durationMs / 1000).toFixed(1)} s · **Código de salida:** ${result.exitCode ?? 'n/a'}\n\n`;
  }
}

// -----------------------------------------------------------------------------
// Helpers exportados (testeables)
// -----------------------------------------------------------------------------

export interface RunnerMessage {
  role?: string;
  type?: string;
  format?: string | null;
  content?: string;
}

export interface RunnerOutput {
  version?: string;
  error?: string;
  messages?: RunnerMessage[];
}

/** El runner imprime una única línea JSON al final; lo anterior (si lo hay) es ruido. */
export function parseRunnerOutput(stdout: string): RunnerOutput | undefined {
  const lines = stdout.trim().split('\n').reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      return JSON.parse(trimmed) as RunnerOutput;
    } catch {
      // seguir buscando
    }
  }
  return undefined;
}

/**
 * Convierte la lista de mensajes de Open Interpreter en Markdown:
 * texto del asistente tal cual, código ejecutado en bloque con su lenguaje y
 * salida de consola en bloque `text`.
 */
export function formatRunnerMessages(messages: RunnerMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const content = (m.content ?? '').trim();
    if (!content) continue;
    if (m.type === 'message') {
      parts.push(content);
    } else if (m.type === 'code') {
      parts.push(`**Ejecuta** (${m.format ?? 'code'}):\n\`\`\`${m.format ?? ''}\n${content}\n\`\`\``);
    } else if (m.type === 'console') {
      parts.push(`**Salida:**\n\`\`\`text\n${truncateMiddle(content, 4000)}\n\`\`\``);
    }
  }
  return parts.length ? parts.join('\n\n') : '_(Open Interpreter terminó sin producir mensajes.)_';
}

/**
 * Busca bloques ```bash / ```sh / ```shell en el texto y devuelve las líneas
 * que empiezan por un comando de la lista blanca. Ignora comentarios, `cd` y
 * cualquier cosa con operadores de shell peligrosos.
 */
export function extractVerificationCommands(text: string): string[] {
  const blocks = [...text.matchAll(/```(?:bash|sh|shell|zsh|console|terminal)?\s*\n([\s\S]*?)```/g)].map(m => m[1]);
  const commands: string[] = [];

  for (const block of blocks) {
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trim().replace(/^\$\s+/, '');
      if (!line || line.startsWith('#')) continue;
      if (/[|;&><`$]/.test(line)) continue; // sin pipes, redirecciones ni sustituciones

      const [bin, sub] = line.split(/\s+/);
      if (!ALLOWED_FALLBACK_COMMANDS.has(bin)) continue;
      if (bin === 'git' && !ALLOWED_GIT_SUBCOMMANDS.has(sub)) continue;
      if (bin === 'pip' && sub !== 'install') continue;
      if ((bin === 'npm' || bin === 'pnpm' || bin === 'yarn') && !/^(test|run|ci|install|i|exec)$/.test(sub ?? '')) continue;

      if (!commands.includes(line)) commands.push(line);
      if (commands.length >= MAX_FALLBACK_COMMANDS) return commands;
    }
  }
  return commands;
}

/** Localiza `interpreter_runner.py` tanto en `src/scripts` como en `dist/scripts`. */
function resolveRunnerPath(): string | undefined {
  const candidates = [
    join(__dirname, '..', 'scripts', 'interpreter_runner.py'),
    join(process.cwd(), 'dist', 'scripts', 'interpreter_runner.py'),
    join(process.cwd(), 'src', 'scripts', 'interpreter_runner.py')
  ];
  return candidates.find(existsSync);
}

function tail(text: string): string {
  const cleaned = text.trim();
  if (!cleaned) return '';
  const last = cleaned.split('\n').slice(-25).join('\n');
  return '\n\n```text\n' + truncateMiddle(last, 3000) + '\n```';
}
