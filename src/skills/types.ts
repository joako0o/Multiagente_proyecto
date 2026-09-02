/**
 * Tipos del subsistema de skills.
 *
 * Una "skill" sigue el estándar Agent Skills (https://agentskills.io/specification):
 * un directorio con un `SKILL.md` (frontmatter YAML `name`/`description` +
 * instrucciones en Markdown) y, opcionalmente, `scripts/`, `references/`, `assets/`.
 */

/** Origen de skills: un repositorio Git (normalmente GitHub). */
export interface SkillSource {
  /** Identificador corto y estable, p. ej. `anthropics/skills`. */
  id: string;
  /** URL clonable. */
  url: string;
  /** Rama o tag; vacío = la rama por defecto. */
  ref?: string;
}

/** Skill descubierta en el catálogo local. */
export interface SkillInfo {
  /** `name` del frontmatter (coincide con el nombre del directorio). */
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  /** Id de la fuente de la que proviene (o `local`). */
  sourceId: string;
  /** Directorio de la skill en el catálogo local. */
  dir: string;
  /** Ruta relativa dentro del repositorio fuente (para trazabilidad). */
  relPath: string;
  /** Archivos auxiliares (relativos al directorio de la skill), sin el SKILL.md. */
  files: string[];
  /** Tamaño en bytes del cuerpo del SKILL.md. */
  bodyBytes: number;
}

/** Asignación de skills a un agente concreto, decidida por el arquitecto o el usuario. */
export type SkillAssignments = Record<string, string[]>;

/** Resultado de materializar skills en un workspace. */
export interface MaterializedSkill {
  name: string;
  /** Directorio final dentro del workspace (`<ws>/.agents/skills/<name>`). */
  dir: string;
  /** Ruta del SKILL.md final. */
  skillFile: string;
}
