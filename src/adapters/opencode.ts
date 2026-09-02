/**
 * Adaptador de OpenCode.
 *
 * OpenCode expone un servidor HTTP (`opencode serve --port 4096`) con una API
 * de sesiones. Flujo:
 *   1. `GET  /global/health`                 → ¿está vivo?
 *   2. `POST /session {title}`               → crear sesión (una por conversación)
 *   3. `POST /session/:id/message {parts}`   → enviar prompt y esperar respuesta
 *
 * La sesión se pasa con `?directory=<workspace>` para que OpenCode trabaje
 * sobre el proyecto correcto.
 *
 * Documentación: https://opencode.ai/docs/server/
 */
import { spawn } from 'child_process';
import { AdapterStatus, AgentAdapter, AgentTask } from '../types';
import { AppConfig } from '../config';

type OpenCodeConfig = AppConfig['opencode'];

const MAX_ATTEMPTS = 3;
const AUTO_START_WAIT_MS = 8_000;

export class OpenCodeAdapter implements AgentAdapter {
  /** Sesión de OpenCode por conversación nuestra. */
  private readonly sessions = new Map<string, string>();
  private autoStartAttempted = false;

  constructor(private readonly config: OpenCodeConfig) {}

  getSourceBackend(): string {
    return `OpenCode server (${this.config.url}) · ${this.config.providerID}/${this.config.modelID}`;
  }

  async getStatus(): Promise<AdapterStatus> {
    const health = await this.health();
    if (health.ok) {
      return { available: true, mode: 'http', detail: `v${health.version ?? '?'} en ${this.config.url}` };
    }
    return {
      available: false,
      mode: 'http',
      detail: `Sin respuesta en ${this.config.url}. Ejecuta \`opencode serve --port 4096\`` +
        (this.config.autoStart ? ' (se intentará arrancar automáticamente en el primer turno)' : '')
    };
  }

  async sendMessage(task: AgentTask): Promise<string> {
    if (!(await this.ensureRunning())) {
      return `### 💻 OpenCode\n\n⚠️ **Servidor no disponible** en \`${this.config.url}\`.\n\n` +
        `Arranca OpenCode con \`opencode serve --port 4096\` y reanuda el ciclo.`;
    }

    let lastError = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const sessionId = await this.getOrCreateSession(task);
        return await this.postMessage(sessionId, task);
      } catch (err) {
        lastError = (err as Error).message;
        console.warn(`[OpenCode] intento ${attempt}/${MAX_ATTEMPTS} falló: ${lastError}`);

        if (/HTTP 404/.test(lastError)) {
          // La sesión expiró o el servidor se reinició: forzamos una nueva.
          this.sessions.delete(task.conversationId);
        }
        if (/HTTP 429/.test(lastError) && attempt < MAX_ATTEMPTS) {
          await sleep(10_000);
        } else if (attempt < MAX_ATTEMPTS) {
          await sleep(2_000 * attempt);
        }
      }
    }

    return `### 💻 OpenCode\n\n⚠️ **Error tras ${MAX_ATTEMPTS} intentos:** ${lastError}`;
  }

  // ---------------------------------------------------------------------------
  // Internos
  // ---------------------------------------------------------------------------

  private async health(): Promise<{ ok: boolean; version?: string }> {
    try {
      const response = await fetch(`${this.config.url}/global/health`, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) return { ok: false };
      const body = await response.json().catch(() => ({})) as { version?: string };
      return { ok: true, version: body.version };
    } catch {
      return { ok: false };
    }
  }

  /** Comprueba el servidor y, si está permitido, intenta levantarlo una sola vez. */
  private async ensureRunning(): Promise<boolean> {
    if ((await this.health()).ok) return true;
    if (!this.config.autoStart || this.autoStartAttempted) return false;

    this.autoStartAttempted = true;
    const port = new URL(this.config.url).port || '4096';
    console.log(`[OpenCode] servidor no detectado; ejecutando "opencode serve --port ${port}"...`);

    try {
      const child = spawn('opencode', ['serve', '--port', port], {
        detached: true,
        stdio: 'ignore',
        shell: process.platform === 'win32',
        windowsHide: true
      });
      child.on('error', (err) => console.warn(`[OpenCode] no se pudo arrancar: ${err.message}`));
      child.unref();
    } catch (err) {
      console.warn(`[OpenCode] no se pudo arrancar: ${(err as Error).message}`);
      return false;
    }

    const deadline = Date.now() + AUTO_START_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(500);
      if ((await this.health()).ok) {
        console.log('[OpenCode] servidor arrancado correctamente');
        return true;
      }
    }
    return false;
  }

  private async getOrCreateSession(task: AgentTask): Promise<string> {
    const existing = this.sessions.get(task.conversationId);
    if (existing) return existing;

    const response = await fetch(`${this.config.url}/session?${this.directoryQuery(task)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `Bridge · ${task.conversationId.slice(0, 8)}` }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} al crear sesión: ${(await response.text()).slice(0, 200)}`);
    }

    const session = await response.json() as { id: string };
    this.sessions.set(task.conversationId, session.id);
    return session.id;
  }

  private async postMessage(sessionId: string, task: AgentTask): Promise<string> {
    const response = await fetch(`${this.config.url}/session/${sessionId}/message?${this.directoryQuery(task)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: { providerID: this.config.providerID, modelID: this.config.modelID },
        parts: [{ type: 'text', text: task.prompt }]
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    const data = await response.json() as OpenCodeMessage;

    const providerError = data.info?.error;
    if (providerError) {
      const message = providerError.data?.message ?? providerError.message ?? providerError.name ?? 'error del proveedor';
      if (providerError.data?.statusCode === 429) {
        throw new Error(`HTTP 429: ${message}`);
      }
      return `### 💻 OpenCode\n\n⚠️ **Error del proveedor de modelo:** ${message}`;
    }

    return formatParts(data.parts ?? []);
  }

  private directoryQuery(task: AgentTask): string {
    return new URLSearchParams({ directory: task.projectPath }).toString();
  }
}

// -----------------------------------------------------------------------------
// Formato de la respuesta
// -----------------------------------------------------------------------------

interface OpenCodeMessage {
  info?: {
    error?: { name?: string; message?: string; data?: { message?: string; statusCode?: number } };
  };
  parts?: OpenCodePart[];
}

interface OpenCodePart {
  type: string;
  text?: string;
  tool?: string;
  state?: { status?: string; title?: string; input?: Record<string, unknown> };
}

/**
 * OpenCode devuelve una lista de "partes": texto, llamadas a herramientas,
 * razonamiento, etc. Mostramos el texto tal cual y resumimos las herramientas
 * usadas para que el arquitecto sepa qué archivos se tocaron.
 */
function formatParts(parts: OpenCodePart[]): string {
  const text = parts.filter(p => p.type === 'text' && p.text).map(p => p.text!.trim()).join('\n\n');
  const tools = parts
    .filter(p => p.type === 'tool')
    .map(p => `- \`${p.tool ?? 'tool'}\` ${p.state?.title ? '— ' + p.state.title : ''} ${p.state?.status === 'error' ? '❌' : ''}`.trim());

  const sections: string[] = [];
  if (text) sections.push(text);
  if (tools.length) sections.push(`**Herramientas ejecutadas:**\n${tools.join('\n')}`);
  if (!sections.length) sections.push('_(OpenCode terminó sin texto de respuesta.)_');
  return sections.join('\n\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
