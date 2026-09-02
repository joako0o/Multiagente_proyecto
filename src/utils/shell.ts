/**
 * Ejecución de procesos externos, multiplataforma.
 *
 * Todos los adaptadores basados en CLI (OpenHands, Aider, Open Interpreter,
 * git) pasan por aquí. Centralizarlo evita repetir el manejo de timeouts,
 * de `ENOENT` (comando no instalado) y las diferencias Windows/Unix.
 */
import { spawn } from 'child_process';

export interface RunResult {
  stdout: string;
  stderr: string;
  /** Código de salida, o `null` si el proceso fue matado por timeout. */
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export interface RunOptions {
  cwd?: string;
  /** Texto a escribir por stdin (se cierra después de escribirlo). */
  input?: string;
  /** Variables extra que se añaden a `process.env`. */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Límite de bytes retenidos por stream para no agotar memoria con salidas enormes. */
  maxOutputBytes?: number;
}

/** Error lanzado cuando el ejecutable no existe en el PATH. */
export class CommandNotFoundError extends Error {
  constructor(public readonly command: string) {
    super(`El comando "${command}" no está instalado o no está en el PATH`);
    this.name = 'CommandNotFoundError';
  }
}

const isWindows = process.platform === 'win32';

/**
 * Ejecuta `command args...` SIN pasar por una shell (evita problemas de
 * escapado con prompts largos que contienen comillas, `$`, backticks, etc.).
 *
 * En Windows los ejecutables instalados por npm/pip suelen ser `.cmd`, que
 * requieren shell; por eso allí sí se usa `shell: true`.
 */
export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { cwd, input, env, timeoutMs = 120_000, maxOutputBytes = 2_000_000 } = options;
  const startedAt = Date.now();

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: isWindows,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Si SIGTERM no basta (p. ej. procesos hijos colgados), forzamos.
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }, timeoutMs);

    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= maxOutputBytes) return current;
      return (current + chunk.toString('utf-8')).slice(0, maxOutputBytes);
    };

    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new CommandNotFoundError(command));
      } else {
        reject(err);
      }
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut, durationMs: Date.now() - startedAt });
    });

    if (input !== undefined) {
      child.stdin.on('error', () => { /* el proceso cerró stdin antes de tiempo; se ignora */ });
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Devuelve `true` si el comando existe y responde a `--version` (o al flag indicado).
 * Nunca lanza; está pensado para comprobaciones de disponibilidad.
 */
export async function commandExists(command: string, versionFlag = '--version'): Promise<{ ok: boolean; version?: string }> {
  try {
    const result = await run(command, [versionFlag], { timeoutMs: 15_000 });
    const firstLine = (result.stdout || result.stderr).trim().split('\n')[0];
    return { ok: result.exitCode === 0, version: firstLine || undefined };
  } catch {
    return { ok: false };
  }
}

/** Recorta un texto largo dejando el principio y el final (útil para logs de terminal). */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n\n[... ${text.length - maxChars} caracteres omitidos ...]\n\n${text.slice(-half)}`;
}
