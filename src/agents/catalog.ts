/**
 * Catálogo de agentes: metadatos de presentación de cada tipo de agente.
 *
 * Es la ÚNICA fuente de verdad para nombre, rol y emoji. El servidor lo expone
 * por API (`GET /api/agents`) y el panel web lo consume, de modo que añadir un
 * agente aquí lo hace aparecer automáticamente en la interfaz y en el historial.
 */
import { AgentDescriptor, AgentType } from '../types';

export const AGENT_CATALOG: Record<AgentType, AgentDescriptor> = {
  antigravity: {
    id: 'antigravity',
    type: 'antigravity',
    name: 'Antigravity',
    emoji: '🏛️',
    shortLabel: 'LLM · Arquitecto',
    loadsSkillsNatively: false,
    role: 'Arquitecto y líder técnico. Planifica en el primer turno, revisa el trabajo del equipo en los siguientes y emite el veredicto final.'
  },
  opencode: {
    id: 'opencode',
    type: 'opencode',
    name: 'OpenCode',
    emoji: '💻',
    shortLabel: 'Servidor local :4096',
    loadsSkillsNatively: true,
    role: 'Desarrollador principal. Implementa el código en el workspace siguiendo el plan del arquitecto.'
  },
  openhands: {
    id: 'openhands',
    type: 'openhands',
    name: 'OpenHands',
    emoji: '🤖',
    shortLabel: 'CLI headless',
    loadsSkillsNatively: true,
    role: 'Ingeniero autónomo. Resuelve tareas completas de punta a punta: explora el repo, edita archivos y ejecuta comandos.'
  },
  aider: {
    id: 'aider',
    type: 'aider',
    name: 'Aider',
    emoji: '🐙',
    shortLabel: 'CLI · Git',
    loadsSkillsNatively: false,
    role: 'Editor de código orientado a Git. Aplica cambios precisos sobre archivos concretos y prepara los commits.'
  },
  interpreter: {
    id: 'interpreter',
    type: 'interpreter',
    name: 'Open Interpreter',
    emoji: '⚡',
    shortLabel: 'CLI · Terminal / QA',
    loadsSkillsNatively: false,
    role: 'Ejecutor y QA. Corre pruebas, scripts y validaciones en el entorno real y reporta los resultados.'
  }
};

/** Orden en que se muestran los agentes en la interfaz. */
export const AGENT_ORDER: AgentType[] = ['antigravity', 'opencode', 'openhands', 'aider', 'interpreter'];

/** Equipo por defecto cuando el usuario no elige ninguno. */
export const DEFAULT_TEAM: AgentType[] = ['antigravity', 'opencode'];

/** Id del agente que actúa como arquitecto/revisor. */
export const ARCHITECT_ID: AgentType = 'antigravity';

export function isAgentType(value: string): value is AgentType {
  return value in AGENT_CATALOG;
}
