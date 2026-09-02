/**
 * Biblioteca de skills: sincroniza repositorios de GitHub con `SKILL.md`,
 * indexa las skills encontradas y las materializa en el workspace de una sesión.
 *
 * Flujo:
 *   1. `sync()`            → `git clone --depth 1` (o `git pull`) de cada fuente
 *                            en `<cacheDir>/<fuente>/`.
 *   2. `list()`            → busca `**\/SKILL.md`, valida el frontmatter y devuelve
 *                            el catálogo (nombre, descripción, origen, archivos).
 *   3. `materialize()`     → copia las skills elegidas a `<workspace>/.agents/skills/<name>/`,
 *                            que es la ruta que OpenHands y OpenCode leen de forma
 *                            nativa (progressive disclosure: metadatos al arrancar,
 *                            cuerpo al activarse). Para el resto de agentes, el
 *                            orquestador inyecta las instrucciones en el prompt.
 *
 * Además de las fuentes remotas hay dos orígenes locales:
 *  - `bundledDirs`: carpetas del propio proyecto (p. ej. `./skills/`) con skills
 *    incluidas de serie; se indexan tal cual, sin copiar.
 *  - `<cacheDir>/local/`: skills propias del usuario sin repositorio; basta con
 *    crear `local/<name>/SKILL.md`.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative, sep } from 'path';
import { MaterializedSkill, SkillInfo, SkillSource } from './types';
import { readSkillFile, SkillFileError } from './skill-file';
import { run } from '../utils/shell';
import { addToGitExclude } from '../utils/git';

/** Directorios que nunca se recorren buscando skills. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'dist', 'build']);
const MAX_DEPTH = 8;
/** Tamaño máximo copiado por skill (scripts/assets); evita traer repos enteros por error. */
const MAX_SKILL_BYTES = 25 * 1024 * 1024;

/** Nombre de la subcarpeta del workspace donde se materializan las skills (estándar). */
export const WORKSPACE_SKILLS_DIR = join('.agents', 'skills');

export interface SyncResult {
  sourceId: string;
  ok: boolean;
  action: 'cloned' | 'updated' | 'unchanged' | 'failed';
  detail?: string;
}

export class SkillLibrary {
  private cache?: SkillInfo[];

  constructor(
    private readonly cacheDir: string,
    private readonly sources: SkillSource[],
    /** Carpetas locales con skills incluidas en el proyecto (se indexan sin copiar). */
    private readonly bundledDirs: string[] = []
  ) {}

  /** Directorio de una fuente dentro de la caché. */
  sourceDir(source: SkillSource): string {
    return join(this.cacheDir, source.id.replace(/[^a-zA-Z0-9._-]+/g, '__'));
  }

  get configuredSources(): SkillSource[] {
    return this.sources;
  }

  // ---------------------------------------------------------------------------
  // Sincronización
  // ---------------------------------------------------------------------------

  /** Clona o actualiza todas las fuentes. Nunca lanza: devuelve el resultado por fuente. */
  async sync(): Promise<SyncResult[]> {
    mkdirSync(join(this.cacheDir, 'local'), { recursive: true });
    const results: SyncResult[] = [];
    for (const source of this.sources) {
      results.push(await this.syncOne(source));
    }
    this.cache = undefined;
    return results;
  }

  private async syncOne(source: SkillSource): Promise<SyncResult> {
    const dir = this.sourceDir(source);
    try {
      if (existsSync(join(dir, '.git'))) {
        const before = await run('git', ['rev-parse', 'HEAD'], { cwd: dir, timeoutMs: 10_000 });
        const pull = await run('git', ['pull', '--ff-only', '--depth', '1', '-q'], { cwd: dir, timeoutMs: 120_000 });
        if (pull.exitCode !== 0) {
          return { sourceId: source.id, ok: true, action: 'unchanged', detail: `no se pudo actualizar (${firstLine(pull.stderr)}); se usa la copia local` };
        }
        const after = await run('git', ['rev-parse', 'HEAD'], { cwd: dir, timeoutMs: 10_000 });
        return { sourceId: source.id, ok: true, action: before.stdout === after.stdout ? 'unchanged' : 'updated' };
      }

      mkdirSync(dirname(dir), { recursive: true });
      const args = ['clone', '--depth', '1', '-q'];
      if (source.ref) args.push('--branch', source.ref);
      args.push(source.url, dir);
      const clone = await run('git', args, { timeoutMs: 180_000, env: { GIT_TERMINAL_PROMPT: '0' } });
      if (clone.exitCode !== 0) {
        rmSync(dir, { recursive: true, force: true });
        return { sourceId: source.id, ok: false, action: 'failed', detail: firstLine(clone.stderr) || 'git clone falló' };
      }
      return { sourceId: source.id, ok: true, action: 'cloned' };
    } catch (err) {
      return { sourceId: source.id, ok: false, action: 'failed', detail: (err as Error).message };
    }
  }

  // ---------------------------------------------------------------------------
  // Catálogo
  // ---------------------------------------------------------------------------

  /** Todas las skills válidas de la caché (fuentes + `local/`). Cacheado hasta el siguiente `sync()`. */
  list(): SkillInfo[] {
    if (this.cache) return this.cache;

    const found = new Map<string, SkillInfo>();
    // Prioridad ante nombres repetidos: local del usuario → incluidas en el proyecto → remotas.
    const roots: Array<[string, string]> = [
      ['local', join(this.cacheDir, 'local')],
      ...this.bundledDirs.map((d): [string, string] => ['bundled', d]),
      ...this.sources.map((s): [string, string] => [s.id, this.sourceDir(s)])
    ];

    for (const [sourceId, root] of roots) {
      if (!existsSync(root)) continue;
      for (const skillFile of findSkillFiles(root)) {
        const info = describeSkill(skillFile, sourceId, root);
        if (!info) continue;
        if (!found.has(info.name)) found.set(info.name, info);
      }
    }

    this.cache = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
    return this.cache;
  }

  get(name: string): SkillInfo | undefined {
    return this.list().find(s => s.name === name);
  }

  /** Cuerpo Markdown de una skill (instrucciones). */
  readBody(name: string): string {
    const info = this.get(name);
    if (!info) throw new Error(`Skill desconocida: ${name}`);
    return readSkillFile(join(info.dir, 'SKILL.md')).body;
  }

  // ---------------------------------------------------------------------------
  // Materialización en el workspace
  // ---------------------------------------------------------------------------

  /**
   * Copia las skills indicadas a `<workspace>/.agents/skills/<name>/` y escribe
   * un `README.md` explicando su origen. Devuelve solo las que existían.
   */
  materialize(workspace: string, names: string[]): MaterializedSkill[] {
    const target = join(workspace, WORKSPACE_SKILLS_DIR);
    mkdirSync(target, { recursive: true });
    // La carpeta es del bridge, no del proyecto del usuario: se ignora localmente sin tocar su .gitignore.
    addToGitExclude(workspace, ['.agents/skills/'], 'Multi-Agent Bridge: skills materializadas por sesión');

    const result: MaterializedSkill[] = [];
    for (const name of [...new Set(names)]) {
      const info = this.get(name);
      if (!info) continue;
      if (directorySize(info.dir) > MAX_SKILL_BYTES) {
        console.warn(`[Skills] "${name}" supera ${MAX_SKILL_BYTES / 1024 / 1024} MB; no se copia`);
        continue;
      }
      const dest = join(target, name);
      rmSync(dest, { recursive: true, force: true });
      cpSync(info.dir, dest, { recursive: true, filter: src => !SKIP_DIRS.has(basename(src)) });
      result.push({ name, dir: dest, skillFile: join(dest, 'SKILL.md') });
    }

    if (result.length) {
      writeFileSync(join(target, 'README.md'), [
        '# Skills de esta sesión',
        '',
        'Directorio generado por Multi-Agent Bridge. Cada subcarpeta es una skill en formato',
        'Agent Skills (https://agentskills.io): `SKILL.md` con instrucciones y, opcionalmente,',
        '`scripts/`, `references/` y `assets/`.',
        '',
        'OpenHands y OpenCode las cargan automáticamente desde aquí; al resto de agentes se',
        'les inyectan en el prompt. Puedes borrar esta carpeta cuando termine la sesión.',
        '',
        ...result.map(r => `- \`${r.name}\` — ${this.get(r.name)?.description ?? ''}`)
      ].join('\n') + '\n', 'utf-8');
    }
    return result;
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Encuentra todos los `SKILL.md` bajo `root` (recursivo, con límites de profundidad y directorios excluidos). */
export function findSkillFiles(root: string, depth = 0): string[] {
  if (depth > MAX_DEPTH) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  const results: string[] = [];
  const hasSkill = entries.some(e => e.toLowerCase() === 'skill.md');
  if (hasSkill) {
    // Un directorio con SKILL.md es una skill; no buscamos skills anidadas dentro.
    const exact = entries.find(e => e === 'SKILL.md') ?? entries.find(e => e.toLowerCase() === 'skill.md')!;
    return [join(root, exact)];
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(root, entry);
    try {
      if (statSync(full).isDirectory()) results.push(...findSkillFiles(full, depth + 1));
    } catch {
      // enlaces rotos, permisos…
    }
  }
  return results;
}

/** Construye la ficha de una skill; devuelve `undefined` (y avisa) si el archivo no cumple el estándar. */
export function describeSkill(skillFile: string, sourceId: string, root: string): SkillInfo | undefined {
  const dir = dirname(skillFile);
  try {
    const parsed = readSkillFile(skillFile);
    if (parsed.frontmatter.name !== basename(dir)) {
      console.warn(`[Skills] ${skillFile}: "name" (${parsed.frontmatter.name}) no coincide con el directorio (${basename(dir)}); se omite`);
      return undefined;
    }
    return {
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      license: parsed.frontmatter.license,
      compatibility: parsed.frontmatter.compatibility,
      sourceId,
      dir,
      relPath: relative(root, dir).split(sep).join('/'),
      files: listFiles(dir).filter(f => f !== 'SKILL.md'),
      bodyBytes: Buffer.byteLength(parsed.body, 'utf-8')
    };
  } catch (err) {
    if (err instanceof SkillFileError) console.warn(`[Skills] ${err.message}; se omite`);
    else console.warn(`[Skills] no se pudo leer ${skillFile}: ${(err as Error).message}`);
    return undefined;
  }
}

function listFiles(dir: string, prefix = '', depth = 0): string[] {
  if (depth > 4) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    try {
      if (statSync(full).isDirectory()) out.push(...listFiles(full, rel, depth + 1));
      else out.push(rel);
    } catch {
      // ignorar
    }
    if (out.length > 200) break;
  }
  return out;
}

function directorySize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      total += st.isDirectory() ? directorySize(full) : st.size;
    } catch {
      // ignorar
    }
    if (total > MAX_SKILL_BYTES) break;
  }
  return total;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}
