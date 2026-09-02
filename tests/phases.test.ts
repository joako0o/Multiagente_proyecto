import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { phaseForTurn } from '../src/core/phases';

describe('phaseForTurn', () => {
  test('el turno 0 siempre es planificación', () => {
    assert.equal(phaseForTurn(0, 'antigravity'), 'PLANNING');
    assert.equal(phaseForTurn(0, 'opencode'), 'PLANNING');
  });

  test('los agentes de desarrollo van a DEVELOPMENT', () => {
    assert.equal(phaseForTurn(1, 'opencode'), 'DEVELOPMENT');
    assert.equal(phaseForTurn(3, 'openhands'), 'DEVELOPMENT');
    assert.equal(phaseForTurn(5, 'aider'), 'DEVELOPMENT');
  });

  test('el interpreter va a EXECUTION y el arquitecto a REVIEW', () => {
    assert.equal(phaseForTurn(2, 'interpreter'), 'EXECUTION');
    assert.equal(phaseForTurn(4, 'antigravity'), 'REVIEW');
  });
});
