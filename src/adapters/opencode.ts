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
 * Verificado contra opencode 1.18.26 (OpenAPI en `GET /doc`): body
 * `{model, parts}` con `parts` obligatorio, respuesta `{info, parts}`, partes
 * `step-start | text | tool | step-finish | …`, y arranque automático con
 * `spawn('opencode', ['serve', '--port', …], {detached: true})`.
 *
 * Proveedores: OpenCode toma los modelos de su propia configuración
 * (`opencode auth login`, `opencode.json` del proyecto o `~/.config/opencode/`).
 * `OPENCODE_PROVIDER`/`OPENCODE_MODEL` deben coincidir con un proveedor conectado;
 * `GET /provider` (campo `connected`) lo muestra.
 *
 * Documentación: https://opencode.ai/docs/server/
 */
import { spawn } from 'child_process';
import { AdapterStatus, AgentAdapter, AgentTask } from '../types';
import { AppConfig } from '../config';
import { createLogger } from '../utils/logger';

const log = createLogger('OpenCode');

type OpenCodeConfig = AppConfig['opencode'];

const MAX_ATTEMPTS = 3;
const AUTO_START_WAIT_MS = 8_000;

export class OpenCodeAdapter implements AgentAdapter {
  /** Sesión de OpenCode por conversación nuestra. */
  private readonly sessions = new Map<string, string>();
  private autoStartAttempted = false;
  /** Skills que OpenCode ya conoce por workspace (para saber cuándo hay que refrescar su caché). */
  private readonly knownSkills = new Map<string, string>();

  constructor(private readonly config: OpenCodeConfig) {}

  getSourceBackend(): string {
    return `OpenCode server (${this.config.url}) · ${this.config.providerID}/${this.config.modelID}`;
  }

  async getStatus(): Promise<AdapterStatus> {
    const health = await this.health();
    if (health.ok) {
      const connected = await this.connectedProviders();
      if (connected && !connected.includes(this.config.providerID)) {
        return {
          available: false,
          mode: 'http',
          detail: `v${health.version} activo, pero el proveedor "${this.config.providerID}" no está conectado en OpenCode ` +
            `(conectados: ${connected.join(', ') || 'ninguno'}). Ejecuta \`opencode auth login\` o ajusta OPENCODE_PROVIDER.`
        };
      }
      return { available: true, mode: 'http', detail: `v${health.version ?? '?'} en ${this.config.url} · ${this.config.providerID}/${this.config.modelID}` };
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
      return `⚠️ **OpenCode: servidor no disponible** en \`${this.config.url}\`.\n\n` +
        `Arranca OpenCode con \`opencode serve --port 4096\` y reanuda el ciclo.`;
    }

    // El proveedor se resuelve por directorio (opencode.json del proyecto + config global):
    // si no está conectado para este workspace, OpenCode responde un 500 genérico.
    // Lo comprobamos antes para dar un mensaje útil en vez de reintentar a ciegas.
    const connected = await this.connectedProviders(task.projectPath);
    if (connected && !connected.includes(this.config.providerID)) {
      return `⚠️ **OpenCode: el proveedor \`${this.config.providerID}\` no está conectado para \`${task.projectPath}\`** ` +
        `(conectados: ${connected.join(', ') || 'ninguno'}). Ejecuta \`opencode auth login\`, declara el proveedor en ` +
        `\`opencode.json\` del proyecto o ajusta OPENCODE_PROVIDER/OPENCODE_MODEL en \`.env\`.`;
    }

    await this.refreshSkillsIfNeeded(task);

    let lastError = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const sessionId = await this.getOrCreateSession(task);
        return await this.postMessage(sessionId, task);
      } catch (err) {
        if (task.signal?.aborted) {
          return '⏹️ **Turno detenido por el usuario.**';
        }
        lastError = (err as Error).message;
        log.warn(`intento ${attempt}/${MAX_ATTEMPTS} falló: ${lastError}`);

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

    return `⚠️ **OpenCode: error tras ${MAX_ATTEMPTS} intentos:** ${lastError}`;
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

  /** Ids de proveedores con credenciales en OpenCode (para un workspace, si se indica), o `undefined` si no se pudo consultar. */
  private async connectedProviders(directory?: string): Promise<string[] | undefined> {
    try {
      const query = directory ? `?${new URLSearchParams({ directory }).toString()}` : '';
      const response = await fetch(`${this.config.url}/provider${query}`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return undefined;
      const body = await response.json() as { connected?: string[] };
      return Array.isArray(body.connected) ? body.connected : undefined;
    } catch {
      return undefined;
    }
  }

  /** Comprueba el servidor y, si está permitido, intenta levantarlo una sola vez. */
  private async ensureRunning(): Promise<boolean> {
    if ((await this.health()).ok) return true;
    if (!this.config.autoStart || this.autoStartAttempted) return false;

    this.autoStartAttempted = true;
    const port = new URL(this.config.url).port || '4096';
    log.info(`servidor no detectado; ejecutando "opencode serve --port ${port}"…`);

    try {
      const child = spawn('opencode', ['serve', '--port', port], {
        detached: true,
        stdio: 'ignore',
        shell: process.platform === 'win32',
        windowsHide: true
      });
      child.on('error', (err) => log.warn('no se pudo arrancar', err));
      child.unref();
    } catch (err) {
      log.warn('no se pudo arrancar', err as Error);
      return false;
    }

    const deadline = Date.now() + AUTO_START_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(500);
      if ((await this.health()).ok) {
        log.info('servidor arrancado correctamente');
        return true;
      }
    }
    return false;
  }

  /**
   * OpenCode escanea `.agents/skills/` una sola vez por directorio y cachea el
   * resultado, así que las skills que el bridge copia después de que el
   * servidor conozca el workspace no se ven. `POST /instance/dispose` descarta
   * esa caché (las sesiones siguen siendo válidas; verificado en 1.18.26).
   */
  private async refreshSkillsIfNeeded(task: AgentTask): Promise<void> {
    const wanted = [...task.skills].sort().join(',');
    if (this.knownSkills.get(task.projectPath) === wanted) return;
    try {
      if (task.skills.length) {
        await fetch(`${this.config.url}/instance/dispose?${this.directoryQuery(task)}`, {
          method: 'POST',
          signal: AbortSignal.timeout(10_000)
        });
      }
      this.knownSkills.set(task.projectPath, wanted);
    } catch (err) {
      log.warn('no se pudo refrescar la caché de skills', err as Error);
    }
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
    // Si el usuario detiene el turno, además de cancelar nuestra petición hay que
    // pedir a OpenCode que aborte la sesión: si no, seguiría trabajando en segundo plano.
    const onAbort = () => {
      fetch(`${this.config.url}/session/${sessionId}/abort?${this.directoryQuery(task)}`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000)
      }).catch(() => { /* mejor esfuerzo */ });
    };
    task.signal?.addEventListener('abort', onAbort, { once: true });

    let response: Response;
    try {
      response = await fetch(`${this.config.url}/session/${sessionId}/message?${this.directoryQuery(task)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: { providerID: this.config.providerID, modelID: this.config.modelID },
          parts: [{ type: 'text', text: task.prompt }]
        }),
        signal: task.signal ? AbortSignal.any([task.signal, AbortSignal.timeout(this.config.timeoutMs)]) : AbortSignal.timeout(this.config.timeoutMs)
      });
    } catch (err) {
      if (task.signal?.aborted) {
        return '⏹️ **Turno detenido por el usuario.** Se pidió a OpenCode que abortara la sesión; revisa el workspace por cambios parciales.';
      }
      throw err;
    } finally {
      task.signal?.removeEventListener('abort', onAbort);
    }

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
      return `⚠️ **OpenCode: error del proveedor de modelo:** ${message}`;
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
