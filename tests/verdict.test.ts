import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, parseTeamSelection, parseNextAgent } from '../src/core/verdict';

describe('parseVerdict', () => {
  test('detecta la línea explícita de aprobación', () => {
    assert.equal(parseVerdict('Todo correcto.\n\nVEREDICTO: APROBADO'), 'APPROVED');
  });

  test('detecta la línea explícita con negrita y espacios', () => {
    assert.equal(parseVerdict('**VEREDICTO:** **REQUIERE_CAMBIOS**'), 'CHANGES_REQUESTED');
  });

  test('la línea explícita manda sobre las palabras sueltas', () => {
    const text = 'El módulo está INCOMPLETO en X, pero ya lo corrigieron.\nVEREDICTO: APROBADO';
    assert.equal(parseVerdict(text), 'APPROVED');
  });

  test('sin línea explícita, una palabra de rechazo pesa más que una de aprobación', () => {
    assert.equal(parseVerdict('APROBADO parcialmente; FALTANTE: pruebas de integración'), 'CHANGES_REQUESTED');
  });

  test('sin línea explícita ni palabras de rechazo, APROBADO aprueba', () => {
    assert.equal(parseVerdict('Revisado. APROBADO.'), 'APPROVED');
  });

  test('devuelve undefined si no hay ninguna señal (turno de planificación)', () => {
    assert.equal(parseVerdict('## Plan\n1. Crear módulo\n2. Probar'), undefined);
  });

  test('no confunde "aprobados" dentro de otra palabra', () => {
    assert.equal(parseVerdict('Los cambios desaprobados se revirtieron.'), undefined);
  });
});

describe('parseTeamSelection', () => {
  const known = (id: string) => ['antigravity', 'opencode', 'openhands', 'aider', 'interpreter'].includes(id);

  test('extrae ids separados por comas', () => {
    assert.deepEqual(parseTeamSelection('[EQUIPO: opencode, interpreter]\n## Plan', known), ['opencode', 'interpreter']);
  });

  test('tolera mayúsculas, espacios y separadores variados', () => {
    assert.deepEqual(parseTeamSelection('[equipo:  OpenHands | Aider ]', known), ['openhands', 'aider']);
  });

  test('descarta ids desconocidos y duplicados', () => {
    assert.deepEqual(parseTeamSelection('[EQUIPO: opencode, cursor, opencode]', known), ['opencode']);
  });

  test('devuelve undefined si no hay etiqueta o ningún id es válido', () => {
    assert.equal(parseTeamSelection('Plan sin equipo', known), undefined);
    assert.equal(parseTeamSelection('[EQUIPO: cursor, manus]', known), undefined);
  });
});

describe('parseNextAgent', () => {
  const known = (id: string) => ['opencode', 'aider', 'interpreter'].includes(id);

  test('extrae el id, tolerando mayúsculas, espacios y backticks', () => {
    assert.equal(parseNextAgent('Falta X.\nVEREDICTO: REQUIERE_CAMBIOS\n[SIGUIENTE: aider]', known), 'aider');
    assert.equal(parseNextAgent('[ siguiente :  `OpenCode` ]', known), 'opencode');
  });

  test('devuelve undefined sin etiqueta o con id desconocido', () => {
    assert.equal(parseNextAgent('VEREDICTO: REQUIERE_CAMBIOS', known), undefined);
    assert.equal(parseNextAgent('[SIGUIENTE: cursor]', known), undefined);
  });
});
