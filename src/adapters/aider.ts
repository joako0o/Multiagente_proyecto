/**
 * Adaptador de Aider (editor de código orientado a Git).
 *
 * Aider se ejecuta en modo no interactivo:
 *
 *   aider --message-file <tarea> --yes-always --no-stream --no-show-release-notes \
 *         [--model <m>] [--no-auto-commits]
 *
 * - `--message-file` envía una sola instrucción y sale (modo scripting).
 * - `--yes-always` acepta todas las confirmaciones (añadir archivos, etc.).
 * - `--no-stream` produce salida limpia para capturar.
 * - Por defecto desactivamos los auto-commits para que sea el usuario quien
 *   confirme; se puede cambiar con `AIDER_AUTO_COMMITS=true`.
 *
 * Además de editar, el adaptador antepone un resumen de `git status` para que
 * el arquitecto vea qué archivos cambiaron en el turno.
 *
 * Documentación: https://aider.chat/docs/scripting.html
 */
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentTask } from '../types';
import { AppConfig } from '../config';
import { RunResult, run } from '../utils/shell';
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
      '--yes-always',
      '--no-stream',
      '--no-show-release-notes',
      '--no-check-update',
      '--no-gitignore'
    ];
    if (this.config.model) args.push('--model', this.config.model);
    if (!this.config.autoCommits) args.push('--no-auto-commits');

    return { command: this.config.command, args };
  }

  protected extractAnswer(result: RunResult): string {
    return cleanAiderOutput(result.stdout);
  }

  /** Sobrescribimos para añadir el estado de git al final de la respuesta. */
  async sendMessage(task: AgentTask): Promise<string> {
    const answer = await super.sendMessage(task);
    const gitSummary = await describeGitState(task.projectPath);
    return gitSummary ? `${answer}\n\n${gitSummary}` : answer;
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Quita el banner de arranque de aider (versión, modelo, repo-map…) y deja el contenido útil. */
export function cleanAiderOutput(stdout: string): string {
  const noise = /^(Aider v|Main model:|Weak model:|Git repo:|Repo-map:|Added .* to the chat\.?$|Tokens: |Warning: )/;
  return stdout
    .split('\n')
    .filter(line => !noise.test(line.trim()))
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
    const files = status.stdout.trim().split('\n').filter(Boolean);
    const body = files.length ? '```text\n' + files.slice(0, 40).join('\n') + (files.length > 40 ? `\n… y ${files.length - 40} más` : '') + '\n```' : '_Árbol de trabajo limpio._';
    return `**Estado Git** · rama \`${branch.stdout.trim() || 'HEAD'}\` · ${files.length} archivo(s) con cambios\n\n${body}`;
  } catch {
    return '';
  }
}
