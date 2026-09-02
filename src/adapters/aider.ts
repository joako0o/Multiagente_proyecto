/**
 * Adaptador de Aider (editor de código orientado a Git).
 *
 * Aider se ejecuta en modo no interactivo:
 *
 *   aider --message-file <tarea> --yes-always --no-stream --no-auto-lint \
 *         --no-auto-test [--model <m>] [--no-auto-commits]
 *
 * - `--message-file` envía una sola instrucción y sale (modo scripting).
 * - `--yes-always` acepta todas las confirmaciones (añadir archivos, etc.).
 * - `--no-stream` produce salida limpia para capturar.
 * - `--no-auto-lint` / `--no-auto-test`: sin ellos, aider vuelve a llamar al
 *   LLM por cada error de lint/test que encuentra (varias rondas por turno).
 *   La validación es trabajo de Open Interpreter.
 * - Por defecto desactivamos los auto-commits para que sea el usuario quien
 *   confirme; se puede cambiar con `AIDER_AUTO_COMMITS=true`.
 *
 * Verificado con aider 0.86.2.
 *
 * Nota sobre el modelo: `AIDER_MODEL` va en formato LiteLLM (`gemini/…`,
 * `openai/…`, `ollama/…`). La API key la lee aider de su entorno habitual
 * (GEMINI_API_KEY, OPENAI_API_KEY, OPENAI_API_BASE…), heredado del proceso.
 *
 * Además de editar, el adaptador añade un resumen de `git status` para que el
 * arquitecto vea qué archivos cambiaron en el turno.
 *
 * Artefactos: aider escribe `.aider.chat.history.md` y `.aider.input.history`
 * en el workspace; se redirigen a un directorio temporal. La caché del mapa
 * del repo (`.aider.tags.cache.v4/`) no tiene opción de ruta, así que se
 * añade a `.git/info/exclude` del proyecto (ignorado sin tocar `.gitignore`).
 *
 * Documentación: https://aider.chat/docs/scripting.html
 */
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentTask } from '../types';
import { AppConfig } from '../config';
import { RunResult, run } from '../utils/shell';
import { addToGitExclude } from '../utils/git';
import { BaseCliAdapter, CliInvocation } from './base-cli-adapter';

type AiderConfig = AppConfig['aider'];

export class AiderAdapter extends BaseCliAdapter {
  constructor(private readonly config: AiderConfig) {
    super('🐙 Aider', config.command, config.timeoutMs);
  }

  getSourceBackend(): string {
    return `Aider CLI · ${this.config.model || 'modelo por defecto de aider'}`;
  }

  protected buildInvocation(task: AgentTask): CliInvocation {
    const dir = mkdtempSync(join(tmpdir(), 'aider-task-'));
    const messageFile = join(dir, 'task.md');
    writeFileSync(messageFile, task.prompt, 'utf-8');

    const args = [
      '--message-file', messageFile,
      // Los historiales de aider se escriben fuera del workspace para no ensuciar el repo del usuario.
      '--chat-history-file', join(dir, 'chat-history.md'),
      '--input-history-file', join(dir, 'input-history'),
      '--yes-always',
      '--no-stream',
      '--no-show-release-notes',
      '--no-show-model-warnings',
      '--no-check-update',
      '--no-gitignore',
      // Sin auto-lint/auto-test: cada corrección automática es otra ronda con
      // el LLM. La validación la hace Open Interpreter en su propio turno.
      '--no-auto-lint',
      '--no-auto-test',
      '--no-analytics'
    ];
    if (this.config.model) args.push('--model', this.config.model);
    if (!this.config.autoCommits) args.push('--no-auto-commits');

    // Aider lee las credenciales del entorno (vía LiteLLM). Solo añadimos lo
    // que el usuario haya configurado explícitamente para este agente.
    const env: Record<string, string> = {};
    if (this.config.apiKey) env.AIDER_API_KEY = this.config.apiKey;   // formato "proveedor=clave"
    if (this.config.baseUrl) env.OPENAI_API_BASE = this.config.baseUrl;

    return { command: this.config.command, args, env };
  }

  protected extractAnswer(result: RunResult): string {
    return cleanAiderOutput(result.stdout);
  }

  /** Sobrescribimos para añadir el estado de git al final de la respuesta. */
  async sendMessage(task: AgentTask): Promise<string> {
    addToGitExclude(task.projectPath, ['.aider*'], 'Multi-Agent Bridge: artefactos de aider');
    const answer = await super.sendMessage(task);
    const gitSummary = await describeGitState(task.projectPath);
    return gitSummary ? `${answer}\n\n${gitSummary}` : answer;
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Quita el ruido de arranque de aider (versión, modelo, repo-map, avisos de
 * git, separadores…) y deja el contenido útil: la explicación del modelo y las
 * líneas "Applied edit to …".
 */
export function cleanAiderOutput(stdout: string): string {
  const noise = [
    /^Aider v\d/,
    /^(Main|Weak) model:/,
    /^Model: /,
    /^Git repo:/,
    /^Repo-map:/,
    /^Added .* to the chat\.?$/,
    /^Tokens: .*Cost:/,
    /^Update git (name|email) with:/,
    /^Warning for .*: Unknown context window/,
    /^You can skip this check with/,
    /^https:\/\/aider\.chat\/docs\/llms\/warnings\.html/,
    /^HTTPSConnectionPool\(/,          // fallo al descargar tabla de precios de LiteLLM (offline)
    /^[─-]{20,}$/                        // separadores
  ];
  return stdout
    .split('\n')
    .map(line => line.replace(/\s+$/, ''))   // aider rellena con espacios hasta 80 columnas
    .filter(line => !noise.some(re => re.test(line.trim())))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Resumen corto de la rama actual y archivos modificados. Devuelve '' si no hay repo git. */
export async function describeGitState(cwd: string): Promise<string> {
  try {
    const branch = await run('git', ['branch', '--show-current'], { cwd, timeoutMs: 5000 });
    if (branch.exitCode !== 0) return '';
    const status = await run('git', ['status', '--short'], { cwd, timeoutMs: 5000 });
    const files = status.stdout.trim().split('\n').filter(Boolean)
      // Ruido que no son cambios del proyecto: archivos internos de aider y cachés de ejecución.
      .filter(line => !/\s(\.aider[.\w-]*|__pycache__\/|\.pytest_cache\/|node_modules\/)/.test(line));
    const body = files.length ? '```text\n' + files.slice(0, 40).join('\n') + (files.length > 40 ? `\n… y ${files.length - 40} más` : '') + '\n```' : '_Árbol de trabajo limpio._';
    return `**Estado Git** · rama \`${branch.stdout.trim() || 'HEAD'}\` · ${files.length} archivo(s) con cambios\n\n${body}`;
  } catch {
    return '';
  }
}
