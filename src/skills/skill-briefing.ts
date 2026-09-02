/**
 * Cómo se presentan las skills a los agentes.
 *
 * Dos vistas:
 *  - `renderCatalogForArchitect()`: lista compacta (nombre + descripción) para
 *    que el arquitecto elija en el turno de planificación con la etiqueta
 *    `[SKILLS: agente=skill1,skill2; agente2=skill3]`.
 *  - `renderBriefingForAgent()`: el "dossier" que recibe un agente en su turno:
 *    dónde están sus skills en el workspace y, para los agentes que no las
 *    cargan solos, el cuerpo de las instrucciones.
 *
 * Funciones puras; la lógica de asignación (`parseSkillAssignments`) también
 * vive aquí para tenerla junto al formato que la produce.
 */
import { MaterializedSkill, SkillAssignments, SkillInfo } from './types';
import { WORKSPACE_SKILLS_DIR } from './skill-library';

/** Máximo de caracteres del cuerpo de una skill que se inyecta en un prompt. */
const MAX_INLINE_BODY_CHARS = 6000;
/** Límite total inyectado por turno (varias skills). */
const MAX_TOTAL_INLINE_CHARS = 14_000;

/**
 * Catálogo para el arquitecto. Se recorta la descripción para que 50 skills
 * quepan en unos pocos miles de tokens.
 */
export function renderCatalogForArchitect(skills: SkillInfo[], maxDescriptionChars = 220): string {
  if (!skills.length) return '_(no hay skills disponibles en la biblioteca)_';
  return skills
    .map(s => `- \`${s.name}\` (${s.sourceId}): ${truncate(s.description, maxDescriptionChars)}`)
    .join('\n');
}

/**
 * Instrucciones para el arquitecto sobre cómo asignar skills.
 * El formato es una única línea, fácil de parsear y de leer en el historial.
 */
export function renderAssignmentInstructions(teamIds: string[]): string {
  return [
    `**Skills.** Dispones de la biblioteca de skills listada abajo (formato Agent Skills: instrucciones + scripts reutilizables).`,
    `Asigna a cada agente las que necesite para su parte del plan, en UNA línea con el formato exacto:`,
    `\`[SKILLS: ${teamIds[0] ?? 'opencode'}=skill-a,skill-b; ${teamIds[1] ?? 'interpreter'}=skill-c]\``,
    `Usa solo nombres de la lista. Si ningún agente necesita skills, escribe \`[SKILLS: ninguna]\`. Máximo 3 skills por agente.`
  ].join('\n');
}

/**
 * Extrae `[SKILLS: agente=a,b; agente2=c]` del texto del arquitecto.
 * Devuelve solo ids de agente y nombres de skill válidos; `{}` si no hay
 * etiqueta, es `ninguna`, o nada es válido.
 */
export function parseSkillAssignments(
  text: string,
  isKnownAgent: (id: string) => boolean,
  isKnownSkill: (name: string) => boolean,
  maxPerAgent = 3
): SkillAssignments {
  const match = text.match(/\[SKILLS\s*:\s*([^\]]*)\]/i);
  if (!match) return {};
  const inner = match[1].trim();
  if (!inner || /^(ninguna|none|no)$/i.test(inner)) return {};

  const result: SkillAssignments = {};
  for (const chunk of inner.split(/[;\n]+/)) {
    const [agentRaw, skillsRaw] = chunk.split('=');
    if (!agentRaw || !skillsRaw) continue;
    const agentId = agentRaw.trim().toLowerCase().replace(/^`|`$/g, '');
    if (!isKnownAgent(agentId)) continue;

    const names = skillsRaw
      .split(/[,\s|]+/)
      .map(s => s.trim().toLowerCase().replace(/^`|`$/g, ''))
      .filter(s => s && isKnownSkill(s));
    if (!names.length) continue;

    result[agentId] = [...new Set([...(result[agentId] ?? []), ...names])].slice(0, maxPerAgent);
  }
  return result;
}

export interface BriefingOptions {
  /** `true` si el agente carga `.agents/skills` por sí mismo (OpenHands, OpenCode). */
  agentLoadsSkillsNatively: boolean;
  /** Lector del cuerpo de la skill (inyectado para no acoplar a disco). */
  readBody: (name: string) => string;
}

/**
 * Dossier de skills para el turno de un agente.
 * - Agentes con soporte nativo: se les indica la ruta y se les recuerda que las usen.
 * - Resto: se inyecta el cuerpo (recortado) y la lista de archivos auxiliares con su ruta absoluta.
 */
export function renderBriefingForAgent(
  skills: Array<{ info: SkillInfo; materialized: MaterializedSkill }>,
  options: BriefingOptions
): string {
  if (!skills.length) return '';

  const lines: string[] = [
    `## Skills asignadas a tu rol`,
    ``,
    `El arquitecto te asignó estas skills (instrucciones + herramientas listas para usar). Están copiadas en \`${WORKSPACE_SKILLS_DIR}/\` dentro del workspace.`,
    ``
  ];

  if (options.agentLoadsSkillsNatively) {
    lines.push(`Tu entorno las carga automáticamente desde esa carpeta; actívalas y sigue sus instrucciones cuando apliquen a tu tarea:`, ``);
    for (const { info, materialized } of skills) {
      lines.push(`- **${info.name}** — ${truncate(info.description, 300)}  \n  Archivo: \`${materialized.skillFile}\``);
    }
    return lines.join('\n');
  }

  let budget = MAX_TOTAL_INLINE_CHARS;
  for (const { info, materialized } of skills) {
    let body = '';
    try {
      body = options.readBody(info.name);
    } catch {
      body = '_(no se pudo leer el cuerpo de la skill)_';
    }
    const allowed = Math.min(MAX_INLINE_BODY_CHARS, budget);
    const shown = body.length > allowed
      ? body.slice(0, allowed) + `\n\n[... instrucciones recortadas; el texto completo está en ${materialized.skillFile} ...]`
      : body;
    budget -= shown.length;

    lines.push(`### Skill: ${info.name}`, ``, `> ${truncate(info.description, 400)}`, ``, `Directorio: \`${materialized.dir}\``);
    if (info.files.length) {
      const shownFiles = info.files.slice(0, 20);
      lines.push(`Archivos auxiliares (rutas relativas a ese directorio): ${shownFiles.map(f => `\`${f}\``).join(', ')}${info.files.length > shownFiles.length ? ` … y ${info.files.length - shownFiles.length} más` : ''}`);
    }
    lines.push(``, shown, ``);
    if (budget <= 0) {
      lines.push(`_(Se omiten las instrucciones de las skills restantes por tamaño; consúltalas en \`${WORKSPACE_SKILLS_DIR}/\`.)_`);
      break;
    }
  }
  return lines.join('\n');
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : clean.slice(0, max - 1) + '…';
}
