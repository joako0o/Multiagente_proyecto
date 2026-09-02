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
 * Comportamientos verificados leyendo el código de openhands 1.16 (flags,
 * esquema de eventos del SDK y manejo de settings); no se pudo ejecutar el
 * binario en este entorno (requiere Python 3.12):
 * - Sin settings guardados (`~/.openhands/agent_settings.json`) y sin
 *   `--override-with-envs`, el CLI imprime "Headless mode requires existing
 *   settings" y termina con código 0 → hay que detectarlo por texto.
 * - Con `--override-with-envs` y sin settings, exige LLM_API_KEY y LLM_MODEL
 *   a la vez (`MissingEnvironmentVariablesError`, código 1).
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

  protected configurationProblem(): string | undefined {
    // Con modelo explícito, OpenHands exige también la clave (salvo que ya tenga settings guardados,
    // pero no podemos saberlo sin ejecutarlo; pedirla evita un fallo confuso en mitad del ciclo).
    if (this.config.model && !this.config.apiKey) {
      return 'OPENHANDS_MODEL está definido pero falta OPENHANDS_API_KEY (o GEMINI_API_KEY)';
    }
    return undefined;
  }

  protected extractAnswer(result: RunResult): string {
    const combined = result.stdout + '\n' + result.stderr;
    if (/Headless mode requires existing settings/i.test(combined)) {
      return '⚠️ OpenHands no tiene configuración guardada. Opciones: ejecutar `openhands` una vez de forma interactiva ' +
        'para configurar el modelo, o definir OPENHANDS_MODEL y OPENHANDS_API_KEY en `.env` para que el bridge lo configure por entorno.';
    }
    if (/Missing required environment variable/i.test(combined)) {
      return '⚠️ OpenHands requiere LLM_API_KEY y LLM_MODEL a la vez cuando se configura por entorno. Revisa OPENHANDS_MODEL / OPENHANDS_API_KEY en `.env`.';
    }
    return parseOpenHandsJsonl(result.stdout) || result.stdout.trim();
  }
}

// -----------------------------------------------------------------------------
// Parseo de la salida JSONL
// -----------------------------------------------------------------------------

/**
 * Subconjunto de los eventos que emite `openhands --headless --json`.
 * Verificado contra openhands 1.16 / openhands-sdk: el discriminador es `kind`
 * (nombre de la clase Pydantic) y cada acción va anidada en `action`.
 */
interface OpenHandsEvent {
  kind?: 'MessageEvent' | 'ActionEvent' | 'ObservationEvent' | 'AgentErrorEvent' | string;
  source?: 'user' | 'agent' | 'environment' | string;
  tool_name?: string;
  action?: {
    kind?: 'TerminalAction' | 'FileEditorAction' | 'FinishAction' | string;
    /** FinishAction: mensaje final para el usuario. */
    message?: string;
    /** TerminalAction: comando de shell. FileEditorAction: subcomando (view/create/str_replace…). */
    command?: string;
    /** FileEditorAction: ruta del archivo. */
    path?: string;
  };
  observation?: { is_error?: boolean };
  /** AgentErrorEvent */
  error?: string;
  llm_message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
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
    } else if (event.kind === 'ActionEvent' && event.action) {
      const { kind, message, command, path } = event.action;
      if (kind === 'FinishAction') {
        finalMessage = String(message ?? '').trim();
      } else if (path) {
        // FileEditorAction también tiene `command` (view/create/str_replace…), por eso `path` se mira primero.
        actions.push(`- 📝 \`${path}\` (${command ?? event.tool_name ?? 'edición'})`);
      } else if (command) {
        actions.push(`- 🖥️ \`${String(command).slice(0, 120)}\``);
      }
    } else if (event.kind === 'ObservationEvent' && event.observation?.is_error) {
      errors++;
    } else if (event.kind === 'AgentErrorEvent' && event.error) {
      errors++;
      agentMessages.push(`⚠️ Error del agente: ${event.error}`);
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
