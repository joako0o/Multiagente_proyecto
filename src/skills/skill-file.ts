/**
 * Lectura y validación de archivos `SKILL.md` (estándar Agent Skills).
 *
 * Funciones puras (sin acceso a disco salvo `readSkillFile`) para poder
 * probarlas fácilmente.
 */
import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';

export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  'allowed-tools'?: string;
}

export interface ParsedSkillFile {
  frontmatter: SkillFrontmatter;
  /** Cuerpo Markdown (instrucciones), sin el frontmatter. */
  body: string;
}

/** Regla del estándar para `name`: minúsculas, dígitos y guiones, sin guiones dobles ni en los extremos. */
const NAME_RULE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class SkillFileError extends Error {
  constructor(message: string, public readonly path?: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'SkillFileError';
  }
}

/**
 * Separa y valida el frontmatter YAML de un SKILL.md.
 * Lanza `SkillFileError` si falta el frontmatter o `name`/`description` no cumplen la especificación.
 */
export function parseSkillFile(content: string, path?: string): ParsedSkillFile {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---[ \t]*\n?([\s\S]*)$/);
  if (!match) {
    throw new SkillFileError('falta el bloque de frontmatter YAML delimitado por ---', path);
  }

  let data: unknown;
  try {
    data = parseYaml(match[1]);
  } catch (err) {
    // Muchas skills escritas a mano tienen descripciones con `:` sin comillas
    // ("Guides through: 1) …"), que YAML estricto rechaza. Antes de rendirnos,
    // leemos los campos de primer nivel como `clave: resto de la línea`.
    data = parseLooseFrontmatter(match[1]);
    if (!data) throw new SkillFileError(`frontmatter YAML inválido: ${(err as Error).message}`, path);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new SkillFileError('el frontmatter debe ser un mapa YAML', path);
  }

  const raw = data as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';

  if (!name || name.length > 64 || !NAME_RULE.test(name)) {
    throw new SkillFileError(`"name" inválido ("${name}"): 1-64 caracteres, solo a-z, 0-9 y guiones simples`, path);
  }
  if (!description) {
    throw new SkillFileError('"description" es obligatorio', path);
  }
  // El estándar fija 1024 caracteres, pero algunas skills publicadas lo superan
  // ligeramente; recortamos en vez de descartar (solo afecta al catálogo, no al cuerpo).
  const frontmatter: SkillFrontmatter = { name, description: description.length > 1024 ? description.slice(0, 1021) + '…' : description };
  if (typeof raw.license === 'string') frontmatter.license = raw.license.trim();
  if (typeof raw.compatibility === 'string') frontmatter.compatibility = raw.compatibility.trim();
  if (typeof raw['allowed-tools'] === 'string') frontmatter['allowed-tools'] = raw['allowed-tools'].trim();
  if (raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)) {
    frontmatter.metadata = Object.fromEntries(
      Object.entries(raw.metadata as Record<string, unknown>).map(([k, v]) => [k, String(v)])
    );
  }

  return { frontmatter, body: match[2].trim() };
}

/**
 * Lector tolerante para frontmatter no estrictamente YAML: cada línea de primer
 * nivel `clave: valor` se toma literal (con continuaciones indentadas para
 * bloques `|`/`>` o texto multilínea). Solo se usa cuando el parser YAML falla.
 */
export function parseLooseFrontmatter(block: string): Record<string, unknown> | undefined {
  const result: Record<string, string> = {};
  let currentKey: string | undefined;
  for (const line of block.split('\n')) {
    const top = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (top) {
      currentKey = top[1];
      result[currentKey] = top[2].replace(/^[|>][-+]?\s*$/, '').trim();
    } else if (currentKey && /^\s+\S/.test(line)) {
      result[currentKey] = `${result[currentKey]} ${line.trim()}`.trim();
    }
  }
  if (!result.name || !result.description) return undefined;
  for (const key of ['name', 'description', 'license', 'compatibility']) {
    if (result[key]) result[key] = result[key].replace(/^["']|["']$/g, '');
  }
  return result;
}

export function readSkillFile(path: string): ParsedSkillFile {
  return parseSkillFile(readFileSync(path, 'utf-8'), path);
}

/** `true` si el texto cumple la regla de nombres del estándar. */
export function isValidSkillName(name: string): boolean {
  return name.length > 0 && name.length <= 64 && NAME_RULE.test(name);
}
