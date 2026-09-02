/**
 * Acceso de solo lectura al workspace: listado, resolución segura y MIME.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listWorkspace, mimeFor, resolveInsideWorkspace, resolveWorkspaceFile, WorkspaceAccessError } from '../src/core/workspace-files';

function makeWorkspace(): { ws: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), 'wsfiles-'));
  const ws = join(base, 'proyecto');
  const outside = join(base, 'secreto.txt');
  mkdirSync(join(ws, 'figuras'), { recursive: true });
  mkdirSync(join(ws, 'node_modules', 'x'), { recursive: true });
  mkdirSync(join(ws, '.git'), { recursive: true });
  mkdirSync(join(ws, '.aider.tags.cache.v4'), { recursive: true });
  writeFileSync(join(ws, '.aider.chat.history.md'), '');
  writeFileSync(join(ws, 'reporte.md'), '# Reporte');
  writeFileSync(join(ws, 'figuras', 'serie.svg'), '<svg/>');
  writeFileSync(join(ws, 'node_modules', 'x', 'index.js'), '');
  writeFileSync(outside, 'no debería verse');
  return { ws, outside };
}

describe('workspace-files', () => {
  test('lista carpetas primero, oculta .git/node_modules/.aider* y usa rutas relativas con /', () => {
    const { ws } = makeWorkspace();
    const entries = listWorkspace(ws);
    assert.deepEqual(entries.map(e => [e.path, e.type]), [['figuras', 'dir'], ['reporte.md', 'file']]);
    assert.deepEqual(listWorkspace(ws, 'figuras').map(e => e.path), ['figuras/serie.svg']);
    assert.equal(entries[1].size, 9);
  });

  test('rechaza salir del workspace con .., rutas absolutas y enlaces simbólicos', () => {
    const { ws, outside } = makeWorkspace();
    assert.throws(() => resolveInsideWorkspace(ws, '../secreto.txt'), (e: WorkspaceAccessError) => e.status === 400);
    assert.throws(() => resolveInsideWorkspace(ws, 'figuras/../../secreto.txt'), (e: WorkspaceAccessError) => e.status === 400);
    // una ruta "absoluta" se trata como relativa al workspace
    assert.throws(() => resolveInsideWorkspace(ws, '/etc/passwd'), (e: WorkspaceAccessError) => e.status === 404);
    symlinkSync(outside, join(ws, 'enlace.txt'));
    assert.throws(() => resolveInsideWorkspace(ws, 'enlace.txt'), (e: WorkspaceAccessError) => e.status === 403);
  });

  test('resolveWorkspaceFile devuelve MIME y rechaza directorios y archivos enormes', () => {
    const { ws } = makeWorkspace();
    const svg = resolveWorkspaceFile(ws, 'figuras/serie.svg');
    assert.equal(svg.mime, 'image/svg+xml');
    assert.equal(svg.size, 6);
    assert.throws(() => resolveWorkspaceFile(ws, 'figuras'), (e: WorkspaceAccessError) => e.status === 400);
    assert.throws(() => resolveWorkspaceFile(ws, 'no-existe.md'), (e: WorkspaceAccessError) => e.status === 404);
  });

  test('mimeFor conoce los formatos de informes y visualización', () => {
    assert.equal(mimeFor('a.md'), 'text/markdown; charset=utf-8');
    assert.equal(mimeFor('a.HTML'), 'text/html; charset=utf-8');
    assert.equal(mimeFor('a.png'), 'image/png');
    assert.equal(mimeFor('a.csv'), 'text/csv; charset=utf-8');
    assert.equal(mimeFor('a.bin'), 'application/octet-stream');
  });
});
