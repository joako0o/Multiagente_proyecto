/**
 * Interpretación de las respuestas del arquitecto.
 *
 * Dos cosas se extraen del texto que devuelve Antigravity:
 *  1. El VEREDICTO en fase de revisión (¿terminamos o seguimos?).
 *  2. El EQUIPO elegido en modo autónomo (`[EQUIPO: opencode, aider]`).
 *
 * Se prioriza la línea explícita `VEREDICTO: ...` que pide el system prompt;
 * las palabras sueltas solo se usan como respaldo si el modelo no la incluyó.
 */
import { Verdict } from '../types';

const EXPLICIT_VERDICT = /VEREDICTO\s*:\s*\**\s*(APROBADO|REQUIERE_CAMBIOS)/i;

const APPROVAL_WORDS = /\b(APROBADO|FINALIZADO|GOAL_REACHED|OBJETIVO CUMPLIDO)\b/i;
const REJECTION_WORDS = /\b(REQUIERE_CAMBIOS|INCOMPLETO|FALTANTE|CORRECCI[OÓ]N REQUERIDA|NO APROBADO|RECHAZADO)\b/i;

/**
 * Devuelve el veredicto detectado, o `undefined` si el texto no contiene
 * ninguna señal clara (por ejemplo, en el turno de planificación).
 */
export function parseVerdict(text: string): Verdict | undefined {
  const explicit = text.match(EXPLICIT_VERDICT);
  if (explicit) {
    return explicit[1].toUpperCase() === 'APROBADO' ? 'APPROVED' : 'CHANGES_REQUESTED';
  }

  // Respaldo: cualquier palabra de rechazo pesa más que una de aprobación,
  // porque "APROBADO parcialmente, INCOMPLETO en X" no debe cerrar el ciclo.
  if (REJECTION_WORDS.test(text)) return 'CHANGES_REQUESTED';
  if (APPROVAL_WORDS.test(text)) return 'APPROVED';
  return undefined;
}

/**
 * Extrae el agente al que el arquitecto quiere pasar el turno: `[SIGUIENTE: aider]`.
 * Devuelve `undefined` si no hay etiqueta o el id no es válido; el orquestador
 * entonces sigue el round-robin normal.
 */
export function parseNextAgent(text: string, isKnownAgent: (id: string) => boolean): string | undefined {
  const match = text.match(/\[\s*SIGUIENTE\s*:\s*`?\s*([a-z0-9_-]+)\s*`?\s*\]/i);
  if (!match) return undefined;
  const id = match[1].toLowerCase();
  return isKnownAgent(id) ? id : undefined;
}

/**
 * Extrae la lista de ids de agentes de una etiqueta `[EQUIPO: a, b, c]`.
 * Solo devuelve los ids que existen según `isKnownAgent`; si no hay etiqueta
 * o ningún id es válido, devuelve `undefined`.
 */
export function parseTeamSelection(text: string, isKnownAgent: (id: string) => boolean): string[] | undefined {
  const match = text.match(/\[EQUIPO\s*:\s*([^\]]+)\]/i);
  if (!match) return undefined;

  const ids = match[1]
    .split(/[,\s|/]+/)
    .map(s => s.trim().toLowerCase())
    .filter(s => s && isKnownAgent(s));

  return ids.length ? [...new Set(ids)] : undefined;
}
