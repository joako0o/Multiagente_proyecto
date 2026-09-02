import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenHandsJsonl } from '../src/adapters/openhands';

describe('parseOpenHandsJsonl', () => {
  test('usa el mensaje de FinishAction y resume acciones', () => {
    const lines = [
      'Initializing agent...',
      JSON.stringify({ kind: 'ActionEvent', tool_name: 'terminal', action: { kind: 'TerminalAction', command: 'npm test' } }),
      JSON.stringify({ kind: 'ObservationEvent', source: 'environment', observation: { is_error: false } }),
      JSON.stringify({ kind: 'ActionEvent', tool_name: 'file_editor', action: { kind: 'FileEditorAction', path: 'src/a.ts' } }),
      JSON.stringify({ kind: 'ActionEvent', tool_name: 'finish', action: { kind: 'FinishAction', message: 'Listo: tests en verde.' } }),
      'Agent finished'
    ];
    const out = parseOpenHandsJsonl(lines.join('\n'));
    assert.match(out, /^Listo: tests en verde\./);
    assert.match(out, /Acciones realizadas \(2\)/);
    assert.match(out, /`npm test`/);
    assert.match(out, /`src\/a\.ts`/);
  });

  test('sin FinishAction usa el último MessageEvent del agente', () => {
    const lines = [
      JSON.stringify({ kind: 'MessageEvent', source: 'user', llm_message: { content: [{ text: 'haz X' }] } }),
      JSON.stringify({ kind: 'MessageEvent', source: 'agent', llm_message: { content: [{ text: 'Primero analizo' }] } }),
      JSON.stringify({ kind: 'MessageEvent', source: 'agent', llm_message: { content: [{ text: 'Hecho X' }] } })
    ];
    assert.equal(parseOpenHandsJsonl(lines.join('\n')), 'Hecho X');
  });

  test('cuenta observaciones con error', () => {
    const lines = [
      JSON.stringify({ kind: 'ActionEvent', action: { kind: 'TerminalAction', command: 'pytest' } }),
      JSON.stringify({ kind: 'ObservationEvent', observation: { is_error: true } }),
      JSON.stringify({ kind: 'ActionEvent', action: { kind: 'FinishAction', message: 'Fallaron tests' } })
    ];
    assert.match(parseOpenHandsJsonl(lines.join('\n')), /1 con error/);
  });

  test('devuelve cadena vacía si no hay JSON', () => {
    assert.equal(parseOpenHandsJsonl('solo texto\nsin json'), '');
  });
});
