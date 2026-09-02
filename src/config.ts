/**
 * Configuración de la aplicación.
 *
 * Único punto donde se leen variables de entorno. El resto del código recibe
 * un `AppConfig` ya tipado y con valores por defecto, de modo que nadie más
 * tiene que hacer `process.env.X || '...'`.
 *
 * Todas las variables están documentadas en `.env.example`.
 */
import { join } from 'path';

export type ArchitectProvider = 'gemini' | 'openai';

export interface AppConfig {
  server: {
    host: string;
    port: number;
  };

  /** Antigravity = agente arquitecto. Habla con un LLM directamente. */
  antigravity: {
    /** `gemini` usa la API oficial de Google; `openai` cualquier endpoint compatible (Ollama, LM Studio, bridge…). */
    provider: ArchitectProvider;
    apiKey: string;
    model: string;
    /** Solo para `provider = openai`. Debe terminar en `/v1`. */
    baseUrl: string;
    timeoutMs: number;
  };

  /** OpenCode = servidor HTTP local (`opencode serve`). */
  opencode: {
    url: string;
    providerID: string;
    modelID: string;
    /** Si el servidor no responde, intentar levantarlo con `opencode serve`. */
    autoStart: boolean;
    timeoutMs: number;
  };

  /** OpenHands = CLI en modo headless. */
  openhands: {
    command: string;
    model: string;
    apiKey: string;
    baseUrl: string;
    timeoutMs: number;
  };

  /** Aider = CLI en modo `--message-file`. */
  aider: {
    command: string;
    model: string;
    autoCommits: boolean;
    timeoutMs: number;
  };

  /** Open Interpreter = CLI `interpreter exec`. */
  interpreter: {
    command: string;
    model: string;
    timeoutMs: number;
  };

  /** Valores por defecto del ciclo de turnos. */
  loop: {
    maxTurns: number;
    delayBetweenTurnsMs: number;
  };

  /** Carpeta donde se guarda el historial `.md` de cada sesión. */
  historyDir: string;
}

type Env = Record<string, string | undefined>;

function str(env: Env, key: string, fallback: string): string {
  const value = env[key];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function int(env: Env, key: string, fallback: number): number {
  const parsed = parseInt(str(env, key, String(fallback)), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const value = str(env, key, String(fallback)).toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
}

/**
 * Construye la configuración a partir de un diccionario de entorno.
 * Se recibe `env` como parámetro (en vez de leer `process.env` dentro) para
 * poder probarlo sin efectos secundarios.
 */
export function loadConfig(env: Env = process.env): AppConfig {
  const geminiKey = str(env, 'GEMINI_API_KEY', '');
  const provider = str(env, 'ANTIGRAVITY_PROVIDER', 'gemini') === 'openai' ? 'openai' : 'gemini';

  return {
    server: {
      host: str(env, 'HOST', 'localhost'),
      port: int(env, 'PORT', 3000)
    },
    antigravity: {
      provider,
      apiKey: str(env, 'ANTIGRAVITY_API_KEY', geminiKey),
      model: str(env, 'ANTIGRAVITY_MODEL', 'gemini-2.5-flash'),
      baseUrl: str(env, 'ANTIGRAVITY_BASE_URL', 'http://127.0.0.1:11435/v1'),
      timeoutMs: int(env, 'ANTIGRAVITY_TIMEOUT_MS', 60_000)
    },
    opencode: {
      url: str(env, 'OPENCODE_URL', 'http://127.0.0.1:4096').replace(/\/+$/, ''),
      providerID: str(env, 'OPENCODE_PROVIDER', 'google'),
      modelID: str(env, 'OPENCODE_MODEL', 'gemini-2.5-flash'),
      autoStart: bool(env, 'OPENCODE_AUTO_START', true),
      timeoutMs: int(env, 'OPENCODE_TIMEOUT_MS', 180_000)
    },
    openhands: {
      command: str(env, 'OPENHANDS_COMMAND', 'openhands'),
      model: str(env, 'OPENHANDS_MODEL', geminiKey ? 'gemini/gemini-2.5-flash' : ''),
      apiKey: str(env, 'OPENHANDS_API_KEY', geminiKey),
      baseUrl: str(env, 'OPENHANDS_BASE_URL', ''),
      timeoutMs: int(env, 'OPENHANDS_TIMEOUT_MS', 600_000)
    },
    aider: {
      command: str(env, 'AIDER_COMMAND', 'aider'),
      model: str(env, 'AIDER_MODEL', geminiKey ? 'gemini/gemini-2.5-flash' : ''),
      autoCommits: bool(env, 'AIDER_AUTO_COMMITS', false),
      timeoutMs: int(env, 'AIDER_TIMEOUT_MS', 300_000)
    },
    interpreter: {
      command: str(env, 'INTERPRETER_COMMAND', 'interpreter'),
      model: str(env, 'INTERPRETER_MODEL', ''),
      timeoutMs: int(env, 'INTERPRETER_TIMEOUT_MS', 300_000)
    },
    loop: {
      maxTurns: int(env, 'LOOP_MAX_TURNS', 15),
      delayBetweenTurnsMs: int(env, 'LOOP_DELAY_MS', 3000)
    },
    historyDir: str(env, 'HISTORY_DIR', join(process.cwd(), 'conversations'))
  };
}
