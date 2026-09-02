import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, setLogLevel, getLogLevel } from '../src/utils/logger';

/** Captura lo escrito en stdout/stderr durante `fn`. */
function capture(fn: () => void): { out: string; err: string } {
  const chunks = { out: '', err: '' };
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  (process.stdout as any).write = (c: string) => { chunks.out += c; return true; };
  (process.stderr as any).write = (c: string) => { chunks.err += c; return true; };
  try { fn(); } finally { (process.stdout as any).write = o; (process.stderr as any).write = e; }
  return chunks;
}

describe('logger', () => {
  const original = getLogLevel();
  afterEach(() => setLogLevel(original));

  test('formato: hora, nivel, módulo, mensaje; warn/error van a stderr', () => {
    setLogLevel('debug');
    const log = createLogger('Mod');
    const { out, err } = capture(() => { log.info('hola'); log.warn('ojo'); log.error('mal', new Error('boom')); log.debug('detalle', { n: 1 }); });
    assert.match(out, /^\d\d:\d\d:\d\d INFO  \[Mod\] hola\n/);
    assert.match(out, /DEBUG \[Mod\] detalle \{"n":1\}\n/);
    assert.match(err, /WARN  \[Mod\] ojo\n/);
    assert.match(err, /ERROR \[Mod\] mal — boom\n/);
  });

  test('el nivel filtra: con warn no salen info ni debug; con silent nada', () => {
    const log = createLogger('Mod');
    setLogLevel('warn');
    const a = capture(() => { log.debug('d'); log.info('i'); log.warn('w'); });
    assert.equal(a.out, '');
    assert.match(a.err, /w\n$/);
    setLogLevel('silent');
    const b = capture(() => { log.error('e'); });
    assert.equal(b.err, '');
  });
});
