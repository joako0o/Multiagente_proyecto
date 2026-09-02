/**
 * Adaptador de OpenHands (agente de ingeniería autónomo).
 *
 * Se usa el CLI en modo headless, pensado para automatización:
 *
 *   openhands --headless --json -f <archivo_con_la_tarea> --override-with-envs
 *
 * - `--headless` ejecuta sin interfaz y auto-aprueba las acciones.
 * - `--json` emite un evento JSON por línea (JSONL); de ahí extraemos el
 *   mensaje final del agente (`FinishAction`) y un resumen de acciones.
 * - `-f` lee la tarea de un archivo (evita límites de longitud de argumentos).
 * - `--override-with-envs` hace que respete LLM_MODEL / LLM_API_KEY / LLM_BASE_URL.
 *
 * Documentación: https://docs.openhands.dev/openhands/usage/cli/command-reference
 */
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentTask } from '../types';
import { AppConfig } from '../config';
import { RunResult } from '../utils/shell';
import { BaseCliAdapter, CliInvocation } from './base-cli-adapter';

type OpenHandsConfig = AppConfig['openhands'];

export class OpenHandsAdapter extends BaseCliAdapter {
  constructor(private readonly config: OpenHandsConfig) {
    super('🤖 OpenHands', config.command, config.timeoutMs);
  }

  getSourceBackend(): string {
    return `OpenHands CLI headless · ${this.config.model || 'modelo configurado en ~/.openhands'}`;
  }

  protected buildInvocation(task: AgentTask): CliInvocation {
    const taskFile = writeTempFile('openhands-task', task.prompt);

    const env: Record<string, string> = {};
    const args = ['--headless', '--json', '-f', taskFile, '--exit-without-confirmation'];

    // Solo sobreescribimos la configuración del usuario si nos han dado un modelo explícito.
    if (this.config.model) {
      args.push('--override-with-envs');
      env.LLM_MODEL = this.config.model;
      if (this.config.apiKey) env.LLM_API_KEY = this.config.apiKey;
      if (this.config.baseUrl) env.LLM_BASE_URL = this.config.baseUrl;
    }

    return { command: this.config.command, args, env };
  }

  protected extractAnswer(result: RunResult): string {
    return parseOpenHandsJsonl(result.stdout) || result.stdout.trim();
  }
}

// -----------------------------------------------------------------------------
// Parseo de la salida JSONL
// -----------------------------------------------------------------------------

interface OpenHandsEvent {
  kind?: string;
  source?: string;
  tool_name?: string;
  action?: { kind?: string; message?: string; command?: string; path?: string; [key: string]: unknown };
  observation?: { is_error?: boolean };
  llm_message?: { content?: Array<{ text?: string }> };
}

/**
 * Convierte el flujo de eventos de OpenHands en un resumen legible:
 * mensajes del agente + lista de acciones (comandos y archivos editados).
 * Las líneas que no son JSON (banners de estado) se ignoran.
 */
export function parseOpenHandsJsonl(output: string): string {
  const events: OpenHandsEvent[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // línea JSON corrupta o parcial: se ignora
    }
  }
  if (!events.length) return '';

  const agentMessages: string[] = [];
  const actions: string[] = [];
  let finalMessage = '';
  let errors = 0;

  for (const event of events) {
    if (event.kind === 'MessageEvent' && event.source === 'agent') {
      const text = event.llm_message?.content?.map(c => c.text ?? '').join('').trim();
      if (text) agentMessages.push(text);
    } else if (event.kind === 'ActionEvent') {
      if (event.action?.kind === 'FinishAction') {
        finalMessage = String(event.action.message ?? '').trim();
      } else if (event.action?.command) {
        actions.push(`- 🖥️ \`${String(event.action.command).slice(0, 120)}\``);
      } else if (event.action?.path) {
        actions.push(`- 📝 \`${event.action.path}\` (${event.tool_name ?? event.action.kind ?? 'edición'})`);
      }
    } else if (event.kind === 'ObservationEvent' && event.observation?.is_error) {
      errors++;
    }
  }

  const sections: string[] = [];
  if (finalMessage) {
    sections.push(finalMessage);
  } else if (agentMessages.length) {
    sections.push(agentMessages[agentMessages.length - 1]);
  }
  if (actions.length) {
    const shown = actions.slice(-25);
    const omitted = actions.length - shown.length;
    sections.push(`**Acciones realizadas (${actions.length}${errors ? `, ${errors} con error` : ''}):**\n` +
      (omitted ? `- … ${omitted} anteriores omitidas\n` : '') + shown.join('\n'));
  }
  return sections.join('\n\n');
}

function writeTempFile(prefix: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const file = join(dir, 'task.md');
  writeFileSync(file, content, 'utf-8');
  return file;
}
