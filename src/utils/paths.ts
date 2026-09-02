/**
 * Utilidades de rutas de proyecto (workspace).
 */
import { existsSync, statSync } from 'fs';
import { resolve } from 'path';

/**
 * Normaliza la ruta que escribe el usuario en el panel:
 *  - quita comillas envolventes (habitual al copiar desde el explorador de Windows),
 *  - recorta espacios,
 *  - la convierte en absoluta.
 * Si viene vacía, devuelve `fallback`.
 */
export function normalizeProjectPath(raw: string | undefined, fallback: string = process.cwd()): string {
  if (!raw) return fallback;
  const cleaned = raw.trim().replace(/^["']+|["']+$/g, '').trim();
  return cleaned ? resolve(cleaned) : fallback;
}

/** `true` si la ruta existe y es un directorio. */
export function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Nombre de archivo seguro (solo letras, números, guion y guion bajo). */
export function toSafeFileName(text: string, maxLength = 40): string {
  const safe = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // quita acentos
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (safe || 'sin_titulo').substring(0, maxLength);
}
