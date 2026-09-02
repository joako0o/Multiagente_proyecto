/**
 * Reglas de fase: qué fase del ciclo corresponde a cada turno.
 *
 * La fase es informativa (se muestra en el panel y se usa para elegir las
 * instrucciones del prompt); no bloquea nada. Se deriva del tipo de agente que
 * tiene el turno:
 *
 *   turno 0                → PLANNING    (el arquitecto planifica)
 *   opencode / openhands / aider → DEVELOPMENT
 *   interpreter            → EXECUTION
 *   antigravity (turno > 0)→ REVIEW
 */
import { AgentType, ConversationPhase } from '../types';

export function phaseForTurn(turn: number, agentType: AgentType): ConversationPhase {
  if (turn === 0) return 'PLANNING';

  switch (agentType) {
    case 'antigravity':
      return 'REVIEW';
    case 'interpreter':
      return 'EXECUTION';
    case 'opencode':
    case 'openhands':
    case 'aider':
      return 'DEVELOPMENT';
  }
}

/** Etiqueta en español para mostrar en la interfaz. */
export const PHASE_LABELS: Record<ConversationPhase, string> = {
  PLANNING: 'Planificación',
  DEVELOPMENT: 'Desarrollo',
  EXECUTION: 'Ejecución / QA',
  REVIEW: 'Revisión',
  COMPLETED: 'Completado'
};
