/**
 * Coordinador de skills: el punto de contacto entre el orquestador y la
 * biblioteca. Decide qué ve cada agente y mantiene el workspace preparado.
 *
 * Responsabilidades:
 *  - Sección de prompt para el arquitecto en planificación (catálogo + formato de asignación).
 *  - Aplicar la etiqueta `[SKILLS: …]` que devuelve el arquitecto.
 *  - Materializar las skills asignadas en `<workspace>/.agents/skills/` antes de
 *    cada turno (idempotente) y construir el dossier del agente.
 *
 * Si el subsistema está desactivado o la biblioteca está vacía, todos los
 * métodos devuelven valores neutros y el orquestador funciona igual que antes.
 */
import { Agent, Conversation } from '../types';
import { SkillLibrary } from './skill-library';
import { parseSkillAssignments, renderAssignmentInstructions, renderBriefingForAgent, renderCatalogForArchitect } from './skill-briefing';
import { selectRelevantSkills } from './skill-search';
import { MaterializedSkill, SkillAssignments, SkillInfo } from './types';
import { SkillSummary } from '../types';
import { createLogger } from '../utils/logger';

const log = createLogger('Skills');

/** Interfaz mínima que necesita el coordinador para resolver ids de agentes. */
export interface AgentLookup {
  has(id: string): boolean;
  get(id: string): Agent | undefined;
}

/** Cuántas skills ve el arquitecto como máximo en el turno de planificación. */
const CATALOG_LIMIT = 25;
/** Con este número o menos, no se filtra: se muestra la biblioteca entera. */
const CATALOG_SHOW_ALL_THRESHOLD = 30;

export class SkillCoordinator {
  /** Skills ya copiadas por workspace, para no repetir la copia en cada turno. */
  private readonly materialized = new Map<string, Map<string, MaterializedSkill>>();

  constructor(private readonly library: SkillLibrary | undefined) {}

  get enabled(): boolean {
    return Boolean(this.library) && this.library!.list().length > 0;
  }

  /** Catálogo serializable para el panel y la API. */
  summaries(): SkillSummary[] {
    if (!this.library) return [];
    return this.library.list().map(toSummary);
  }

  /** Solo los nombres válidos de una asignación propuesta (p. ej. desde el formulario del panel). */
  sanitizeAssignments(input: Record<string, string[]> | undefined, agents: AgentLookup): SkillAssignments {
    if (!input || !this.library) return {};
    const result: SkillAssignments = {};
    for (const [agentId, names] of Object.entries(input)) {
      if (!agents.has(agentId) || !Array.isArray(names)) continue;
      const valid = [...new Set(names.filter(n => typeof n === 'string' && this.library!.get(n)))];
      if (valid.length) result[agentId] = valid;
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Turno del arquitecto
  // ---------------------------------------------------------------------------

  /**
   * Sección para el prompt de planificación: instrucciones de asignación + catálogo.
   *
   * Con bibliotecas grandes solo se muestran las skills relevantes para el
   * objetivo (ranking léxico local, ver `skill-search.ts`), más las que el
   * usuario ya asignó a mano. Así el arquitecto elige entre ~25 candidatas en
   * vez de leer cientos de descripciones.
   */
  sectionForArchitect(conversation: Conversation): string {
    if (!this.enabled) return '';
    const teamWithoutArchitect = conversation.agents.filter(id => id !== 'antigravity');
    const all = this.library!.list();
    const goal = conversation.messages.find(m => m.role === 'user')?.content ?? conversation.title;
    const pinned = Object.values(conversation.skills).flat();

    let shown = all;
    let note = '';
    if (all.length > CATALOG_SHOW_ALL_THRESHOLD) {
      shown = selectRelevantSkills(all, goal, { limit: CATALOG_LIMIT, pinned }).map(r => r.skill);
      note = `_Se muestran las ${shown.length} skills más relevantes para el objetivo, de ${all.length} disponibles. ` +
        `Si necesitas otra, indícalo en tu plan (el usuario puede asignarla) o pide al equipo que consulte \`.agents/skills/README.md\`._`;
    }

    return [
      `## Biblioteca de skills`,
      ``,
      renderAssignmentInstructions(teamWithoutArchitect),
      ``,
      ...(note ? [note, ``] : []),
      renderCatalogForArchitect(shown)
    ].join('\n');
  }

  /** Búsqueda para la API/panel: skills relevantes para un texto libre. */
  search(query: string, limit = 20): Array<{ name: string; score: number; matched: string[] }> {
    if (!this.library) return [];
    return selectRelevantSkills(this.library.list(), query, { limit }).map(r => ({ name: r.skill.name, score: r.score, matched: r.matched }));
  }

  /**
   * Lee `[SKILLS: …]` de la respuesta del arquitecto y la fusiona con las
   * asignaciones existentes (las del usuario prevalecen si hay conflicto).
   * Devuelve una descripción legible del resultado, o `undefined` si no cambió nada.
   */
  applyArchitectAssignments(conversation: Conversation, response: string, agents: AgentLookup): string | undefined {
    if (!this.enabled) return undefined;
    const proposed = parseSkillAssignments(
      response,
      id => agents.has(id) && conversation.agents.includes(id),
      name => Boolean(this.library!.get(name))
    );
    if (!Object.keys(proposed).length) return undefined;

    let changed = false;
    for (const [agentId, names] of Object.entries(proposed)) {
      const merged = [...new Set([...(conversation.skills[agentId] ?? []), ...names])];
      if (merged.length !== (conversation.skills[agentId] ?? []).length) {
        conversation.skills[agentId] = merged;
        changed = true;
      }
    }
    if (!changed) return undefined;

    return Object.entries(conversation.skills)
      .map(([agentId, names]) => `${agents.get(agentId)?.name ?? agentId}: ${names.join(', ')}`)
      .join(' · ');
  }

  // ---------------------------------------------------------------------------
  // Turno de un agente
  // ---------------------------------------------------------------------------

  /** Nombres de skills asignadas a un agente en esta conversación. */
  skillsFor(conversation: Conversation, agentId: string): string[] {
    return conversation.skills[agentId] ?? [];
  }

  /**
   * Garantiza que las skills del agente están en el workspace y devuelve el
   * dossier para su prompt ('' si no tiene skills).
   */
  prepareTurn(conversation: Conversation, agent: Agent): string {
    const names = this.skillsFor(conversation, agent.id);
    if (!names.length || !this.library) return '';

    const ready = this.ensureMaterialized(conversation.projectPath, names);
    const entries = names
      .map(name => {
        const info = this.library!.get(name);
        const materialized = ready.get(name);
        return info && materialized ? { info, materialized } : undefined;
      })
      .filter((e): e is { info: SkillInfo; materialized: MaterializedSkill } => Boolean(e));

    return renderBriefingForAgent(entries, {
      agentLoadsSkillsNatively: agent.loadsSkillsNatively,
      readBody: name => this.library!.readBody(name)
    });
  }

  private ensureMaterialized(workspace: string, names: string[]): Map<string, MaterializedSkill> {
    let done = this.materialized.get(workspace);
    if (!done) {
      done = new Map();
      this.materialized.set(workspace, done);
    }
    const missing = names.filter(n => !done!.has(n));
    if (missing.length) {
      try {
        for (const m of this.library!.materialize(workspace, missing)) done.set(m.name, m);
      } catch (err) {
        log.warn(`no se pudieron copiar skills a ${workspace}`, err as Error);
      }
    }
    return done;
  }
}

function toSummary(info: SkillInfo): SkillSummary {
  return {
    name: info.name,
    description: info.description,
    sourceId: info.sourceId,
    license: info.license,
    fileCount: info.files.length
  };
}
