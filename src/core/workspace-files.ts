/**
 * Acceso de solo lectura a los archivos del workspace de una sesión, para que
 * el panel pueda listar y previsualizar lo que producen los agentes (reportes
 * Markdown, gráficos SVG/PNG, HTML con d3, CSV…).
 *
 * Seguridad: toda ruta se resuelve dentro del workspace y se rechaza cualquier
 * intento de salir de él (`..`, rutas absolutas, enlaces simbólicos que apunten
 * fuera). Nunca se escribe ni se ejecuta nada desde aquí.
 */
import { readdirSync, realpathSync, statSync } from 'fs';
import { extname, join, relative, resolve, sep } from 'path';

export interface WorkspaceEntry {
  /** Ruta relativa al workspace con separador `/`. */
  path: string;
  name: string;
  type: 'file' | 'dir';
  size: number;
  /** ISO 8601 de la última modificación. */
  modifiedAt: string;
}

/** Directorios que no se listan (ruido o potencialmente enormes). */
const HIDDEN_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache', 'dist', 'build', '.next', '.cache']);
/** Prefijos de nombres ocultos: artefactos de las herramientas que orquestamos. */
const HIDDEN_PREFIXES = ['.aider'];
const MAX_ENTRIES = 500;
/** Tamaño máximo de un archivo que se sirve para previsualizar (10 MB). */
export const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;

export class WorkspaceAccessError extends Error {
  constructor(message: string, public readonly status: 400 | 403 | 404 | 413) {
    super(message);
    this.name = 'WorkspaceAccessError';
  }
}

/**
 * Resuelve una ruta relativa dentro del workspace y verifica que el resultado
 * real (tras enlaces simbólicos) sigue dentro. Lanza `WorkspaceAccessError`.
 */
export function resolveInsideWorkspace(workspace: string, relativePath: string): string {
  const cleaned = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (cleaned.split('/').some(part => part === '..')) {
    throw new WorkspaceAccessError('La ruta no puede salir del workspace', 400);
  }

  let root: string;
  try {
    root = realpathSync(workspace);
  } catch {
    throw new WorkspaceAccessError('El workspace no existe', 404);
  }

  const candidate = resolve(root, cleaned);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new WorkspaceAccessError('Archivo no encontrado', 404);
  }

  if (real !== root && !real.startsWith(root + sep)) {
    throw new WorkspaceAccessError('La ruta apunta fuera del workspace', 403);
  }
  return real;
}

/** Lista un directorio del workspace (no recursivo), carpetas primero. */
export function listWorkspace(workspace: string, relativeDir = ''): WorkspaceEntry[] {
  const dir = resolveInsideWorkspace(workspace, relativeDir);
  if (!statSync(dir).isDirectory()) {
    throw new WorkspaceAccessError('La ruta no es un directorio', 400);
  }
  const root = realpathSync(workspace);

  const entries: WorkspaceEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (HIDDEN_DIRS.has(name) || HIDDEN_PREFIXES.some(p => name.startsWith(p))) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      entries.push({
        path: relative(root, full).split(sep).join('/'),
        name,
        type: st.isDirectory() ? 'dir' : 'file',
        size: st.isDirectory() ? 0 : st.size,
        modifiedAt: st.mtime.toISOString()
      });
    } catch {
      // enlaces rotos, permisos…
    }
    if (entries.length >= MAX_ENTRIES) break;
  }

  return entries.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)));
}

/** Ruta real de un archivo del workspace, validada y con límite de tamaño. */
export function resolveWorkspaceFile(workspace: string, relativePath: string): { path: string; size: number; mime: string } {
  const path = resolveInsideWorkspace(workspace, relativePath);
  const st = statSync(path);
  if (!st.isFile()) throw new WorkspaceAccessError('La ruta no es un archivo', 400);
  if (st.size > MAX_PREVIEW_BYTES) throw new WorkspaceAccessError('Archivo demasiado grande para previsualizar', 413);
  return { path, size: st.size, mime: mimeFor(path) };
}

/** Tipos MIME de los formatos habituales en informes y visualizaciones. */
export function mimeFor(path: string): string {
  const table: Record<string, string> = {
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.py': 'text/plain; charset=utf-8',
    '.js': 'text/plain; charset=utf-8',
    '.ts': 'text/plain; charset=utf-8',
    '.css': 'text/plain; charset=utf-8',
    '.yml': 'text/plain; charset=utf-8',
    '.yaml': 'text/plain; charset=utf-8',
    '.toml': 'text/plain; charset=utf-8',
    '.r': 'text/plain; charset=utf-8',
    '.sql': 'text/plain; charset=utf-8',
    '.log': 'text/plain; charset=utf-8'
  };
  return table[extname(path).toLowerCase()] ?? 'application/octet-stream';
}
