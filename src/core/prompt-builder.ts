/**
 * Construcción del prompt que recibe cada agente en su turno.
 *
 * Estructura:
 *   1. Contexto de la sesión (proyecto, workspace, fase, turno, equipo).
 *   2. Instrucciones específicas del rol del agente.
 *   3. Objetivo original del usuario (siempre presente para no perderlo).
 *   4. Historial reciente (últimos N mensajes, recortados).
 *
 * Mantener este archivo separado permite ajustar los prompts sin tocar la
 * lógica del orquestador.
 */
import { Agent, Conversation, ConversationMessage } from '../types';
import { AGENT_CATALOG } from '../agents/catalog';
import { PHASE_LABELS } from './phases';

const RECENT_MESSAGES = 6;
const MAX_CHARS_PER_MESSAGE = 6000;

export interface PromptContext {
  conversation: Conversation;
  agent: Agent;
  /** Agentes participantes (resueltos), para describir el equipo. */
  team: Agent[];
  /** Función para obtener el nombre visible de un agentId (incluye `user`). */
  displayName: (agentId: string) => string;
}

export function buildPrompt(ctx: PromptContext): string {
  const { conversation, agent, team } = ctx;
  const teammates = team.filter(a => a.id !== agent.id);
  const originalGoal = conversation.messages.find(m => m.role === 'user')?.content ?? '(sin objetivo registrado)';

  const sections = [
    `# Sesión de trabajo colaborativa`,
    ``,
    `- **Proyecto:** ${conversation.title}`,
    `- **Workspace (directorio de trabajo):** \`${conversation.projectPath}\``,
    `- **Fase actual:** ${PHASE_LABELS[conversation.phase]}`,
    `- **Turno:** ${conversation.currentTurn + 1} de ${conversation.maxTurns}`,
    `- **Modo de orquestación:** ${conversation.orchestrationMode === 'autonomous' ? 'autónomo' : 'manual'}`,
    `- **Equipo:** ${team.map(a => `${a.emoji} ${a.name}`).join(', ')}`,
    ``,
    `## Tu rol en este turno`,
    ``,
    roleInstructions(ctx, teammates),
    ``,
    `## Objetivo original del usuario`,
    ``,
    originalGoal,
    ``,
    `## Historial reciente`,
    ``,
    formatHistory(conversation.messages, ctx.displayName),
    ``,
    `---`,
    `Responde en español y en Markdown. No repitas el historial; aporta solo tu trabajo de este turno.`
  ];

  return sections.join('\n');
}

// -----------------------------------------------------------------------------
// Instrucciones por rol
// -----------------------------------------------------------------------------

function roleInstructions(ctx: PromptContext, teammates: Agent[]): string {
  const { conversation, agent } = ctx;
  const isFirstTurn = conversation.currentTurn === 0;

  switch (agent.type) {
    case 'antigravity':
      return isFirstTurn ? architectPlanningInstructions(ctx, teammates) : architectReviewInstructions(teammates);

    case 'opencode':
      return [
        `Eres **${agent.name}**, desarrollador principal. Trabajas directamente sobre los archivos del workspace.`,
        `- Implementa lo que el arquitecto te asignó en su último plan o revisión. Crea o modifica los archivos necesarios.`,
        `- Al terminar, resume: archivos creados/modificados, decisiones tomadas y cómo verificar el resultado.`,
        `- Incluye en un bloque \`\`\`bash los comandos exactos para probar tu trabajo (tests, build, ejecución).`
      ].join('\n');

    case 'openhands':
      return [
        `Eres **${agent.name}**, ingeniero de software autónomo con acceso completo al workspace.`,
        `- Resuelve de punta a punta la tarea que te asignó el arquitecto: explora el código, implementa, ejecuta y corrige hasta que funcione.`,
        `- Termina con un resumen claro de lo hecho, los archivos tocados y los comandos de verificación en un bloque \`\`\`bash.`
      ].join('\n');

    case 'aider':
      return [
        `Eres **${agent.name}**, editor de código integrado con Git.`,
        `- Aplica los cambios concretos que pide el arquitecto sobre los archivos indicados. Sé quirúrgico: modifica solo lo necesario.`,
        `- Si el plan no nombra archivos, identifica los relevantes tú mismo y explícalo.`,
        `- Al terminar, indica qué archivos cambiaron y qué comandos ejecutar para verificarlo (bloque \`\`\`bash).`
      ].join('\n');

    case 'interpreter':
      return [
        `Eres **${agent.name}**, responsable de ejecución y QA en el entorno real.`,
        `- Ejecuta los comandos de verificación propuestos por el equipo (tests, build, scripts). Si no hay ninguno, propón y ejecuta las comprobaciones mínimas razonables para este proyecto.`,
        `- Reporta la salida real de cada comando y un veredicto claro: qué funciona y qué falla, con el error exacto.`,
        `- No corrijas código: tu trabajo es evidenciar el estado, no arreglarlo.`
      ].join('\n');
  }
}

function architectPlanningInstructions(ctx: PromptContext, teammates: Agent[]): string {
  const lines = [
    `Eres **Antigravity**, arquitecto y líder técnico. Este es el turno de **planificación**.`,
    `1. Analiza el objetivo del usuario y el workspace indicado.`,
    `2. Define la arquitectura y las decisiones técnicas clave (lenguaje, estructura de archivos, dependencias).`,
    `3. Reparte el trabajo en tareas concretas y asigna cada una a un agente del equipo, con criterios de aceptación verificables.`
  ];

  if (ctx.conversation.orchestrationMode === 'autonomous') {
    const roster = Object.values(AGENT_CATALOG)
      .filter(a => a.id !== 'antigravity')
      .map(a => `   - \`${a.id}\` (${a.name}): ${a.role}`)
      .join('\n');
    lines.push(
      `4. **Elige el equipo.** Estás en modo autónomo: decide qué agentes participan y declara tu elección en la PRIMERA línea de tu respuesta con el formato exacto \`[EQUIPO: id1, id2, ...]\`. Agentes disponibles:`,
      roster,
      `   Elige solo los necesarios; un equipo pequeño itera más rápido.`
    );
  } else {
    lines.push(`4. El equipo ya está definido: ${teammates.map(a => `${a.name} (${a.role})`).join('; ')}.`);
  }

  return lines.join('\n');
}

function architectReviewInstructions(teammates: Agent[]): string {
  return [
    `Eres **Antigravity**, arquitecto y líder técnico. Este es un turno de **revisión**.`,
    `1. Evalúa con rigor lo entregado por el equipo (${teammates.map(a => a.name).join(', ')}): código, salidas de terminal y estado de git.`,
    `2. Si hay errores o trabajo incompleto, indica correcciones concretas y a qué agente corresponden.`,
    `3. Si el objetivo original está completo y verificado, apruébalo.`,
    ``,
    `Termina SIEMPRE con una única línea de veredicto:`,
    `- \`VEREDICTO: APROBADO\` si todo está completo y validado.`,
    `- \`VEREDICTO: REQUIERE_CAMBIOS\` si falta algo (y detalla qué).`
  ].join('\n');
}

// -----------------------------------------------------------------------------
// Historial
// -----------------------------------------------------------------------------

function formatHistory(messages: ConversationMessage[], displayName: (id: string) => string): string {
  const recent = messages.slice(-RECENT_MESSAGES);
  if (!recent.length) return '_(sin mensajes previos)_';

  return recent.map(m => {
    const who = m.role === 'user' ? '👤 Usuario' : m.role === 'system' ? '⚙️ Sistema' : displayName(m.agentId);
    const body = m.content.length > MAX_CHARS_PER_MESSAGE
      ? m.content.slice(0, MAX_CHARS_PER_MESSAGE) + `\n\n[... mensaje recortado, ${m.content.length - MAX_CHARS_PER_MESSAGE} caracteres más ...]`
      : m.content;
    return `### ${who}\n\n${body}`;
  }).join('\n\n');
}
