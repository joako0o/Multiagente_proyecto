import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'path';
import { normalizeProjectPath, toSafeFileName, isDirectory } from '../src/utils/paths';

describe('paths', () => {
  test('normalizeProjectPath quita comillas y espacios y resuelve a absoluta', () => {
    assert.equal(normalizeProjectPath('  "/tmp/mi proyecto"  '), resolve('/tmp/mi proyecto'));
    assert.equal(normalizeProjectPath("'rel/dir'"), resolve('rel/dir'));
    assert.equal(normalizeProjectPath(undefined, '/fallback'), '/fallback');
    assert.equal(normalizeProjectPath('   ', '/fallback'), '/fallback');
  });

  test('toSafeFileName elimina acentos y símbolos y limita longitud', () => {
    assert.equal(toSafeFileName('Análisis TPM: 2026 / v2'), 'Analisis_TPM_2026_v2');
    assert.equal(toSafeFileName('***'), 'sin_titulo');
    assert.equal(toSafeFileName('x'.repeat(100)).length, 40);
  });

  test('isDirectory', () => {
    assert.equal(isDirectory(process.cwd()), true);
    assert.equal(isDirectory('/ruta/que/no/existe'), false);
    assert.equal(isDirectory(__filename), false);
  });
});
