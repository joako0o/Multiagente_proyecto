/**
 * Base común para los adaptadores que envuelven una herramienta de línea de
 * comandos (OpenHands, Aider, Open Interpreter).
 *
 * Aporta:
 *  - comprobación de disponibilidad con caché (no se ejecuta `--version` en cada turno),
 *  - manejo homogéneo de "no instalado", timeout y código de salida distinto de 0,
 *  - formato Markdown consistente para la respuesta que ve el resto del equipo.
 *
 * Las subclases solo deciden QUÉ comando lanzar (`buildInvocation`) y cómo
 * extraer el texto útil de la salida (`extractAnswer`).
 */
import { AdapterStatus, AgentAdapter, AgentTask } from '../types';
import { CommandNotFoundError, RunResult, commandExists, run, truncateMiddle } from '../utils/shell';

export interface CliInvocation {
  command: string;
  args: string[];
  /** Texto para stdin (algunas herramientas prefieren el prompt por stdin). */
  input?: string;
  env?: Record<string, string>;
}

const STATUS_CACHE_TTL_MS = 60_000;
const MAX_ANSWER_CHARS = 12_000;

export abstract class BaseCliAdapter implements AgentAdapter {
  private cachedStatus?: { value: AdapterStatus; at: number };

  protected constructor(
    /** Nombre visible, solo para mensajes. */
    protected readonly displayName: string,
    protected readonly command: string,
    protected readonly timeoutMs: number
  ) {}

  abstract getSourceBackend(): string;

  /** Construye el comando concreto para una tarea. */
  protected abstract buildInvocation(task: AgentTask): CliInvocation;

  /**
   * Extrae la respuesta "humana" de la salida del proceso. Por defecto usa
   * stdout completo; las subclases pueden parsear JSONL, quitar banners, etc.
   */
  protected extractAnswer(result: RunResult): string {
    return result.stdout.trim();
  }

  /**
   * Comprobaciones adicionales de configuración (p. ej. falta el modelo).
   * Devuelve un mensaje de error o `undefined` si todo está bien.
   */
  protected configurationProblem(): string | undefined {
    return undefined;
  }

  async getStatus(): Promise<AdapterStatus> {
    const now = Date.now();
    if (this.cachedStatus && now - this.cachedStatus.at < STATUS_CACHE_TTL_MS) {
      return this.cachedStatus.value;
    }

    const problem = this.configurationProblem();
    const probe = await commandExists(this.command);

    let value: AdapterStatus;
    if (!probe.ok) {
      value = { available: false, mode: 'missing', detail: `"${this.command}" no encontrado en el PATH` };
    } else if (problem) {
      value = { available: false, mode: 'misconfigured', detail: problem };
    } else {
      value = { available: true, mode: 'cli', detail: probe.version };
    }

    this.cachedStatus = { value, at: now };
    return value;
  }

  async sendMessage(task: AgentTask): Promise<string> {
    const problem = this.configurationProblem();
    if (problem) {
      return this.unavailableMessage(problem);
    }

    const invocation = this.buildInvocation(task);
    let result: RunResult;

    try {
      result = await run(invocation.command, invocation.args, {
        cwd: task.projectPath,
        input: invocation.input,
        env: invocation.env,
        timeoutMs: this.timeoutMs
      });
    } catch (err) {
      if (err instanceof CommandNotFoundError) {
        this.cachedStatus = undefined;
        return this.unavailableMessage(`${err.message}. Instálalo y reinicia el servidor.`);
      }
      throw err;
    }

    const answer = this.extractAnswer(result);
    const header = `### ${this.displayName}\n\n` +
      `- **Comando:** \`${[invocation.command, ...invocation.args.map(shortenArg)].join(' ')}\`\n` +
      `- **Workspace:** \`${task.projectPath}\`\n` +
      `- **Duración:** ${(result.durationMs / 1000).toFixed(1)} s · **Código de salida:** ${result.exitCode ?? 'n/a'}\n\n`;

    if (result.timedOut) {
      return header + `⏱️ **Tiempo agotado** tras ${this.timeoutMs / 1000} s. Salida parcial:\n\n` + fence(answer || result.stderr);
    }

    if (result.exitCode !== 0) {
      const errorText = result.stderr.trim() || answer || '(sin salida)';
      return header + `⚠️ **El proceso terminó con error.**\n\n` + fence(truncateMiddle(errorText, MAX_ANSWER_CHARS));
    }

    if (!answer) {
      return header + '_(El agente terminó sin producir texto de respuesta.)_';
    }

    return header + truncateMiddle(answer, MAX_ANSWER_CHARS);
  }

  private unavailableMessage(reason: string): string {
    return `### ${this.displayName}\n\n⚠️ **Agente no disponible:** ${reason}\n\n` +
      `_Este turno se salta. El arquitecto debe reasignar la tarea o el usuario debe instalar/configurar la herramienta._`;
  }
}

function fence(text: string): string {
  return '```text\n' + text.trim() + '\n```';
}

/** Evita volcar el prompt completo (que puede ser enorme) en la línea de comando mostrada. */
function shortenArg(arg: string): string {
  if (arg.length <= 60) return arg;
  return JSON.stringify(arg.slice(0, 57) + '...');
}
