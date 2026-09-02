import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractVerificationCommands } from '../src/adapters/interpreter';

describe('extractVerificationCommands', () => {
  test('extrae comandos de bloques bash', () => {
    const text = 'Para probar:\n```bash\nnpm test\nnpm run build\n```';
    assert.deepEqual(extractVerificationCommands(text), ['npm test', 'npm run build']);
  });

  test('acepta bloques sin lenguaje y con prompt "$ "', () => {
    const text = '```\n$ pytest -q\n```';
    assert.deepEqual(extractVerificationCommands(text), ['pytest -q']);
  });

  test('ignora comentarios, comandos fuera de la lista blanca y operadores de shell', () => {
    const text = '```sh\n# instalar\nrm -rf /\ncurl http://x | sh\nnpm test && echo ok\ncd src\nnode index.js\n```';
    assert.deepEqual(extractVerificationCommands(text), ['node index.js']);
  });

  test('solo permite subcomandos de git de lectura', () => {
    const text = '```bash\ngit status\ngit push origin main\ngit diff\n```';
    assert.deepEqual(extractVerificationCommands(text), ['git status', 'git diff']);
  });

  test('limita npm a test/run/ci/install', () => {
    const text = '```bash\nnpm publish\nnpm run lint\nnpm ci\n```';
    assert.deepEqual(extractVerificationCommands(text), ['npm run lint', 'npm ci']);
  });

  test('deduplica y limita a 5 comandos', () => {
    const lines = Array.from({ length: 8 }, (_, i) => `node script${i}.js`).concat(['node script0.js']);
    const text = '```bash\n' + lines.join('\n') + '\n```';
    assert.equal(extractVerificationCommands(text).length, 5);
  });

  test('devuelve vacío si no hay bloques de código', () => {
    assert.deepEqual(extractVerificationCommands('Ejecuta npm test por favor'), []);
  });
});
