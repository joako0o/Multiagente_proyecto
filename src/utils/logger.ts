/**
 * Logger mínimo con niveles y prefijo por módulo. Sin dependencias.
 *
 *   const log = createLogger('OpenCode');
 *   log.info('servidor arrancado');        → 12:34:56 INFO  [OpenCode] servidor arrancado
 *   log.debug('respuesta', { parts: 3 });  → solo con LOG_LEVEL=debug
 *
 * Nivel por variable de entorno `LOG_LEVEL` (debug | info | warn | error;
 * por defecto `info`). Se lee una sola vez al cargar el módulo; `setLogLevel()`
 * permite cambiarlo en tests. Los objetos extra se serializan en JSON compacto
 * para que una línea siga siendo una línea.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

let currentLevel: LogLevel = parseLevel(process.env.LOG_LEVEL);

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function parseLevel(raw: string | undefined): LogLevel {
  const value = (raw ?? '').trim().toLowerCase();
  return value in LEVELS ? (value as LogLevel) : 'info';
}

export interface Logger {
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
}

export function createLogger(module: string): Logger {
  const emit = (level: Exclude<LogLevel, 'silent'>, message: string, extra?: unknown) => {
    if (LEVELS[level] < LEVELS[currentLevel]) return;
    const time = new Date().toISOString().slice(11, 19);
    const line = `${time} ${level.toUpperCase().padEnd(5)} [${module}] ${message}${formatExtra(extra)}`;
    // warn/error a stderr para que se puedan separar al redirigir la salida.
    (level === 'warn' || level === 'error' ? process.stderr : process.stdout).write(line + '\n');
  };
  return {
    debug: (m, e) => emit('debug', m, e),
    info: (m, e) => emit('info', m, e),
    warn: (m, e) => emit('warn', m, e),
    error: (m, e) => emit('error', m, e)
  };
}

function formatExtra(extra: unknown): string {
  if (extra === undefined) return '';
  if (extra instanceof Error) return ` — ${extra.message}`;
  if (typeof extra === 'string') return ` — ${extra}`;
  try {
    return ' ' + JSON.stringify(extra);
  } catch {
    return ` ${String(extra)}`;
  }
}
