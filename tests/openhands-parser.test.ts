import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenHandsJsonl } from '../src/adapters/openhands';

describe('parseOpenHandsJsonl', () => {
  // Formas de evento tomadas de openhands-sdk (TerminalAction, FileEditorAction, FinishAction).
  test('usa el mensaje de FinishAction y resume acciones', () => {
    const lines = [
      'Initializing agent...',
      JSON.stringify({ kind: 'ActionEvent', source: 'agent', tool_name: 'terminal', action: { kind: 'TerminalAction', command: 'npm test', is_input: false, timeout: null } }),
      JSON.stringify({ kind: 'ObservationEvent', source: 'environment', tool_name: 'terminal', observation: { kind: 'TerminalObservation', is_error: false, exit_code: 0 } }),
      JSON.stringify({ kind: 'ActionEvent', source: 'agent', tool_name: 'file_editor', action: { kind: 'FileEditorAction', command: 'str_replace', path: '/repo/src/a.ts', old_str: 'x', new_str: 'y' } }),
      JSON.stringify({ kind: 'ActionEvent', source: 'agent', tool_name: 'finish', action: { kind: 'FinishAction', message: 'Listo: tests en verde.' } }),
      'Agent finished'
    ];
    const out = parseOpenHandsJsonl(lines.join('\n'));
    assert.match(out, /^Listo: tests en verde\./);
    assert.match(out, /Acciones realizadas \(2\)/);
    assert.match(out, /🖥️ `npm test`/);
    // FileEditorAction también tiene `command`; debe mostrarse como edición de archivo, no como comando de shell.
    assert.match(out, /📝 `\/repo\/src\/a\.ts` \(str_replace\)/);
    assert.doesNotMatch(out, /🖥️ `str_replace`/);
  });

  test('AgentErrorEvent se refleja en la salida', () => {
    const lines = [
      JSON.stringify({ kind: 'AgentErrorEvent', source: 'agent', tool_name: 'terminal', error: 'Tool execution failed' })
    ];
    const out = parseOpenHandsJsonl(lines.join('\n'));
    assert.match(out, /Error del agente: Tool execution failed/);
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
