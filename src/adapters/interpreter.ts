/**
 * Adaptador de Open Interpreter (ejecutor de código y QA).
 *
 * Se utiliza el modo no interactivo del CLI moderno:
 *
 *   interpreter exec --skip-git-repo-check --ephemeral --sandbox workspace-write \
 *                    --ask-for-approval never [--model <m>] -
 *
 * El prompt entra por stdin (`-`) y la respuesta final se imprime por stdout;
 * el progreso va por stderr, por lo que stdout queda limpio para capturarlo.
 *
 * Si el CLI no está instalado, el adaptador entra en MODO FALLBACK: ejecuta
 * localmente los comandos de verificación que el equipo haya propuesto en los
 * bloques ```bash del último mensaje (limitado a una lista blanca de
 * herramientas de test/build), de forma que el ciclo siga aportando
 * validación real aunque no haya un LLM detrás.
 *
 * Documentación: https://www.openinterpreter.com/docs/terminal/exec
 */
import { AdapterStatus, AgentTask } from '../types';
import { AppConfig } from '../config';
import { RunResult, commandExists, run, truncateMiddle } from '../utils/shell';
import { BaseCliAdapter, CliInvocation } from './base-cli-adapter';

type InterpreterConfig = AppConfig['interpreter'];

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

export class InterpreterAdapter extends BaseCliAdapter {
  constructor(private readonly config: InterpreterConfig) {
    super('⚡ Open Interpreter', config.command, config.timeoutMs);
  }

  getSourceBackend(): string {
    return `Open Interpreter CLI (exec) · ${this.config.model || 'modelo configurado'}`;
  }

  protected buildInvocation(task: AgentTask): CliInvocation {
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '--sandbox', 'workspace-write',
      '--ask-for-approval', 'never'
    ];
    if (this.config.model) args.push('--model', this.config.model);
    args.push('-'); // leer el prompt por stdin
    return { command: this.config.command, args, input: task.prompt };
  }

  protected extractAnswer(result: RunResult): string {
    return result.stdout.trim();
  }

  /** Disponible siempre: con el CLI si está instalado, en fallback si no. */
  async getStatus(): Promise<AdapterStatus> {
    const probe = await commandExists(this.config.command);
    if (probe.ok) {
      return { available: true, mode: 'cli', detail: probe.version };
    }
    return {
      available: true,
      mode: 'fallback',
      detail: `"${this.config.command}" no instalado: se ejecutarán solo los comandos de verificación propuestos en el chat`
    };
  }

  async sendMessage(task: AgentTask): Promise<string> {
    const probe = await commandExists(this.config.command);
    if (probe.ok) {
      return super.sendMessage(task);
    }
    return this.runFallback(task);
  }

  // ---------------------------------------------------------------------------
  // Modo fallback (sin CLI)
  // ---------------------------------------------------------------------------

  private async runFallback(task: AgentTask): Promise<string> {
    const commands = extractVerificationCommands(task.prompt);
    const header = `### ⚡ Open Interpreter (modo verificación local)\n\n` +
      `_El CLI \`${this.config.command}\` no está instalado; se ejecutan únicamente los comandos de prueba/build propuestos por el equipo._\n\n` +
      `- **Workspace:** \`${task.projectPath}\`\n\n`;

    if (!commands.length) {
      return header +
        `ℹ️ No se encontraron comandos ejecutables en el último mensaje. ` +
        `Para que este agente valide algo, el desarrollador debe incluir un bloque \`\`\`bash con comandos como \`npm test\`, \`pytest\` o \`npm run build\`.`;
    }

    const reports: string[] = [];
    let failures = 0;

    for (const command of commands) {
      const [bin, ...args] = command.split(/\s+/);
      const result = await run(bin, args, { cwd: task.projectPath, timeoutMs: Math.min(this.config.timeoutMs, 120_000) })
        .catch((err: Error) => ({ stdout: '', stderr: err.message, exitCode: 127, timedOut: false, durationMs: 0 } as RunResult));

      const ok = result.exitCode === 0 && !result.timedOut;
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
