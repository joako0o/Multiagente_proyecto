/**
 * Utilidades Git sobre el workspace del usuario.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Añade patrones a `.git/info/exclude` del repositorio en `cwd`. A diferencia
 * de `.gitignore`, ese archivo es local y no forma parte del proyecto del
 * usuario, así que los artefactos del bridge quedan ignorados sin ensuciar su
 * repo. Idempotente; no hace nada si `cwd` no es un repositorio. Nunca lanza.
 */
export function addToGitExclude(cwd: string, patterns: string[], comment: string): void {
  try {
    if (!existsSync(join(cwd, '.git'))) return;
    const infoDir = join(cwd, '.git', 'info');
    mkdirSync(infoDir, { recursive: true });
    const excludeFile = join(infoDir, 'exclude');
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf-8') : '';
    const existing = new Set(current.split('\n').map(l => l.trim()));
    const missing = patterns.filter(p => !existing.has(p));
    if (!missing.length) return;
    const prefix = current && !current.endsWith('\n') ? '\n' : '';
    appendFileSync(excludeFile, `${prefix}# ${comment}\n${missing.join('\n')}\n`);
  } catch {
    // no es crítico
  }
}
