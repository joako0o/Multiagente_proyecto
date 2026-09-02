/**
 * Pruebas del subsistema de skills: parseo de SKILL.md, catálogo en disco,
 * materialización en un workspace y asignación por el arquitecto.
 * Usa directorios temporales; no toca la red.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseSkillFile, isValidSkillName, SkillFileError } from '../src/skills/skill-file';
import { SkillLibrary, findSkillFiles } from '../src/skills/skill-library';
import { SkillCoordinator } from '../src/skills/skill-coordinator';
import { parseSkillAssignments, renderBriefingForAgent, renderCatalogForArchitect } from '../src/skills/skill-briefing';
import { parseSkillSources } from '../src/config';
import { AGENT_CATALOG } from '../src/agents/catalog';
import { Agent, AgentAdapter, Conversation } from '../src/types';

const SKILL = (name: string, description = `Skill ${name} para pruebas.`, extra = '') =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nInstrucciones de ${name}.\n`;

/** Crea una caché de skills con la estructura que deja `git clone` de una fuente. */
function makeCache(): { cacheDir: string; sourceDir: string } {
  const cacheDir = mkdtempSync(join(tmpdir(), 'skills-cache-'));
  const sourceDir = join(cacheDir, 'acme__skills');
  mkdirSync(join(sourceDir, '.git'), { recursive: true });
  for (const name of ['pdf', 'xlsx', 'webapp-testing']) {
    mkdirSync(join(sourceDir, 'skills', name, 'scripts'), { recursive: true });
    writeFileSync(join(sourceDir, 'skills', name, 'SKILL.md'), SKILL(name));
    writeFileSync(join(sourceDir, 'skills', name, 'scripts', 'run.py'), 'print(1)\n');
  }
  // inválida: el nombre no coincide con el directorio
  mkdirSync(join(sourceDir, 'skills', 'broken'), { recursive: true });
  writeFileSync(join(sourceDir, 'skills', 'broken', 'SKILL.md'), SKILL('otro-nombre'));
  // local
  mkdirSync(join(cacheDir, 'local', 'mi-skill'), { recursive: true });
  writeFileSync(join(cacheDir, 'local', 'mi-skill', 'SKILL.md'), SKILL('mi-skill', 'Skill local propia.'));
  return { cacheDir, sourceDir };
}

function makeLibrary() {
  const { cacheDir } = makeCache();
  return new SkillLibrary(cacheDir, [{ id: 'acme/skills', url: 'https://example.invalid/acme/skills.git' }]);
}

const dummyAdapter: AgentAdapter = { sendMessage: async () => '', getStatus: async () => ({ available: true, mode: 't' }), getSourceBackend: () => 't' };
const agents = {
  has: (id: string) => id in AGENT_CATALOG,
  get: (id: string): Agent | undefined => (id in AGENT_CATALOG ? { ...AGENT_CATALOG[id as keyof typeof AGENT_CATALOG], adapter: dummyAdapter } : undefined)
};

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1', title: 't', agents: ['antigravity', 'opencode', 'interpreter'], messages: [], status: 'active', phase: 'PLANNING',
    orchestrationMode: 'autonomous', projectPath: mkdtempSync(join(tmpdir(), 'ws-')), currentTurn: 0, maxTurns: 10,
    skills: {}, createdAt: new Date(), updatedAt: new Date(), ...overrides
  };
}

describe('parseSkillFile', () => {
  test('lee frontmatter y cuerpo', () => {
    const parsed = parseSkillFile(SKILL('pdf', 'Trabaja con PDFs.', 'license: Apache-2.0\nmetadata:\n  author: acme\n'));
    assert.equal(parsed.frontmatter.name, 'pdf');
    assert.equal(parsed.frontmatter.description, 'Trabaja con PDFs.');
    assert.equal(parsed.frontmatter.license, 'Apache-2.0');
    assert.deepEqual(parsed.frontmatter.metadata, { author: 'acme' });
    assert.match(parsed.body, /^# pdf/);
  });

  test('tolera BOM y CRLF', () => {
    const parsed = parseSkillFile('\uFEFF' + SKILL('x').replace(/\n/g, '\r\n'));
    assert.equal(parsed.frontmatter.name, 'x');
  });

  test('rechaza nombres fuera del estándar y descripciones vacías', () => {
    assert.throws(() => parseSkillFile(SKILL('PDF-Tools')), SkillFileError);
    assert.throws(() => parseSkillFile(SKILL('-pdf')), SkillFileError);
    assert.throws(() => parseSkillFile(SKILL('a--b')), SkillFileError);
    assert.throws(() => parseSkillFile('---\nname: ok\ndescription: ""\n---\n'), SkillFileError);
    assert.throws(() => parseSkillFile('# sin frontmatter'), SkillFileError);
  });

  test('recorta descripciones que superan los 1024 caracteres en vez de descartar la skill', () => {
    const parsed = parseSkillFile(SKILL('larga', 'x'.repeat(1500)));
    assert.equal(parsed.frontmatter.description.length, 1022);
    assert.match(parsed.frontmatter.description, /…$/);
  });

  test('isValidSkillName', () => {
    assert.ok(isValidSkillName('data-analysis'));
    assert.ok(!isValidSkillName('Data'));
    assert.ok(!isValidSkillName('a'.repeat(65)));
  });
});

describe('SkillLibrary', () => {
  test('indexa fuentes y local, omite inválidas y da prioridad a local', () => {
    const lib = makeLibrary();
    const names = lib.list().map(s => s.name);
    assert.deepEqual(names, ['mi-skill', 'pdf', 'webapp-testing', 'xlsx']);
    assert.equal(lib.get('mi-skill')?.sourceId, 'local');
    assert.equal(lib.get('pdf')?.sourceId, 'acme/skills');
    assert.deepEqual(lib.get('pdf')?.files, ['scripts/run.py']);
    assert.equal(lib.get('pdf')?.relPath, 'skills/pdf');
  });

  test('findSkillFiles no desciende dentro de una skill ni en .git/node_modules', () => {
    const { sourceDir } = makeCache();
    mkdirSync(join(sourceDir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(sourceDir, 'node_modules', 'x', 'SKILL.md'), SKILL('x'));
    mkdirSync(join(sourceDir, 'skills', 'pdf', 'nested'), { recursive: true });
    writeFileSync(join(sourceDir, 'skills', 'pdf', 'nested', 'SKILL.md'), SKILL('nested'));
    const found = findSkillFiles(sourceDir).map(f => f.replace(sourceDir, ''));
    assert.ok(!found.some(f => f.includes('node_modules')));
    assert.ok(!found.some(f => f.includes('nested')));
    assert.equal(found.length, 4); // pdf, xlsx, webapp-testing, broken
  });

  test('materialize copia a <ws>/.agents/skills/<name> con README e ignora desconocidas', () => {
    const lib = makeLibrary();
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    const done = lib.materialize(ws, ['pdf', 'no-existe', 'pdf']);
    assert.deepEqual(done.map(d => d.name), ['pdf']);
    assert.ok(existsSync(join(ws, '.agents', 'skills', 'pdf', 'SKILL.md')));
    assert.ok(existsSync(join(ws, '.agents', 'skills', 'pdf', 'scripts', 'run.py')));
    assert.match(readFileSync(join(ws, '.agents', 'skills', 'README.md'), 'utf-8'), /`pdf`/);
  });

  test('readBody devuelve solo las instrucciones', () => {
    assert.match(makeLibrary().readBody('xlsx'), /^# xlsx/);
  });

  test('indexa carpetas bundled del proyecto con prioridad sobre las remotas', () => {
    const { cacheDir } = makeCache();
    const bundled = mkdtempSync(join(tmpdir(), 'bundled-'));
    mkdirSync(join(bundled, 'pdf'), { recursive: true });
    writeFileSync(join(bundled, 'pdf', 'SKILL.md'), SKILL('pdf', 'Versión del proyecto.'));
    mkdirSync(join(bundled, 'econometria'), { recursive: true });
    writeFileSync(join(bundled, 'econometria', 'SKILL.md'), SKILL('econometria'));
    const lib = new SkillLibrary(cacheDir, [{ id: 'acme/skills', url: 'x' }], [bundled]);
    assert.equal(lib.get('pdf')?.sourceId, 'bundled');
    assert.equal(lib.get('pdf')?.description, 'Versión del proyecto.');
    assert.equal(lib.get('econometria')?.sourceId, 'bundled');
    assert.equal(lib.get('xlsx')?.sourceId, 'acme/skills');
  });

  test('las skills incluidas en el repositorio (./skills) son válidas', () => {
    const lib = new SkillLibrary(mkdtempSync(join(tmpdir(), 'empty-')), [], [join(__dirname, '..', 'skills')]);
    const names = lib.list().map(s => s.name);
    assert.deepEqual(names, ['api-financiera-cliente', 'econometria-series-temporales', 'visualizacion-d3']);
    assert.ok(lib.get('econometria-series-temporales')!.files.includes('scripts/analisis_base.py'));
  });
});

describe('parseSkillAssignments', () => {
  const known = (id: string) => ['opencode', 'interpreter', 'aider'].includes(id);
  const skill = (n: string) => ['pdf', 'xlsx', 'webapp-testing'].includes(n);

  test('parsea varios agentes y skills', () => {
    const out = parseSkillAssignments('[SKILLS: opencode=pdf,xlsx; interpreter=webapp-testing]', known, skill);
    assert.deepEqual(out, { opencode: ['pdf', 'xlsx'], interpreter: ['webapp-testing'] });
  });

  test('descarta agentes y skills desconocidos, duplicados y respeta el máximo', () => {
    const out = parseSkillAssignments('[SKILLS: opencode=pdf, pdf, nope, xlsx, webapp-testing; cursor=pdf]', known, skill, 2);
    assert.deepEqual(out, { opencode: ['pdf', 'xlsx'] });
  });

  test('ninguna / sin etiqueta → {}', () => {
    assert.deepEqual(parseSkillAssignments('[SKILLS: ninguna]', known, skill), {});
    assert.deepEqual(parseSkillAssignments('sin etiqueta', known, skill), {});
  });

  test('tolera backticks y mayúsculas', () => {
    assert.deepEqual(parseSkillAssignments('[SKILLS: `OpenCode`=`PDF`]', known, skill), { opencode: ['pdf'] });
  });
});

describe('SkillCoordinator', () => {
  test('sin biblioteca es neutro', () => {
    const c = new SkillCoordinator(undefined);
    const conv = conversation();
    assert.equal(c.enabled, false);
    assert.equal(c.sectionForArchitect(conv), '');
    assert.equal(c.prepareTurn(conv, agents.get('opencode')!), '');
    assert.deepEqual(c.sanitizeAssignments({ opencode: ['pdf'] }, agents), {});
  });

  test('el arquitecto ve el catálogo con el formato de asignación', () => {
    const c = new SkillCoordinator(makeLibrary());
    const section = c.sectionForArchitect(conversation());
    assert.match(section, /\[SKILLS: opencode=skill-a,skill-b; interpreter=skill-c\]/);
    assert.match(section, /`pdf` \(acme\/skills\)/);
    assert.match(section, /`mi-skill` \(local\)/);
  });

  test('aplica la etiqueta del arquitecto, fusiona con las del usuario y materializa en el turno', () => {
    const c = new SkillCoordinator(makeLibrary());
    const conv = conversation({ skills: c.sanitizeAssignments({ opencode: ['xlsx'], nadie: ['pdf'] }, agents) });
    assert.deepEqual(conv.skills, { opencode: ['xlsx'] });

    const summary = c.applyArchitectAssignments(conv, 'Plan…\n[SKILLS: opencode=pdf; interpreter=webapp-testing; aider=pdf]', agents);
    assert.deepEqual(conv.skills, { opencode: ['xlsx', 'pdf'], interpreter: ['webapp-testing'] }); // aider no está en el equipo
    assert.match(summary!, /OpenCode: xlsx, pdf/);

    // Agente con soporte nativo: dossier corto con ruta, sin cuerpo inyectado
    const nativeBrief = c.prepareTurn(conv, agents.get('opencode')!);
    assert.match(nativeBrief, /carga automáticamente/);
    assert.match(nativeBrief, /\.agents[\\/]skills[\\/]pdf[\\/]SKILL\.md/);
    assert.doesNotMatch(nativeBrief, /Instrucciones de pdf/);
    assert.ok(existsSync(join(conv.projectPath, '.agents', 'skills', 'xlsx', 'SKILL.md')));

    // Agente sin soporte nativo: cuerpo inyectado + archivos auxiliares
    const inlineBrief = c.prepareTurn(conv, agents.get('interpreter')!);
    assert.match(inlineBrief, /### Skill: webapp-testing/);
    assert.match(inlineBrief, /Instrucciones de webapp-testing/);
    assert.match(inlineBrief, /`scripts\/run\.py`/);

    assert.deepEqual(c.skillsFor(conv, 'interpreter'), ['webapp-testing']);
    assert.deepEqual(c.skillsFor(conv, 'aider'), []);
  });

  test('una segunda etiqueta sin novedades no genera mensaje', () => {
    const c = new SkillCoordinator(makeLibrary());
    const conv = conversation({ skills: { opencode: ['pdf'] } });
    assert.equal(c.applyArchitectAssignments(conv, '[SKILLS: opencode=pdf]', agents), undefined);
  });
});

describe('renderers', () => {
  test('renderCatalogForArchitect recorta descripciones largas', () => {
    const lib = makeLibrary();
    const long = { ...lib.get('pdf')!, description: 'x'.repeat(500) };
    const out = renderCatalogForArchitect([long], 50);
    assert.ok(out.length < 120);
    assert.match(out, /…$/);
  });

  test('renderBriefingForAgent recorta cuerpos enormes y remite al archivo', () => {
    const info = makeLibrary().get('pdf')!;
    const out = renderBriefingForAgent(
      [{ info, materialized: { name: 'pdf', dir: '/ws/.agents/skills/pdf', skillFile: '/ws/.agents/skills/pdf/SKILL.md' } }],
      { agentLoadsSkillsNatively: false, readBody: () => 'y'.repeat(20_000) }
    );
    assert.match(out, /instrucciones recortadas; el texto completo está en \/ws\/\.agents\/skills\/pdf\/SKILL\.md/);
    assert.ok(out.length < 8000);
  });
});

describe('parseSkillSources', () => {
  test('owner/repo, con ref y URLs', () => {
    assert.deepEqual(parseSkillSources('anthropics/skills, microsoft/skills@main'), [
      { id: 'anthropics/skills', url: 'https://github.com/anthropics/skills.git', ref: undefined },
      { id: 'microsoft/skills', url: 'https://github.com/microsoft/skills.git', ref: 'main' }
    ]);
    assert.deepEqual(parseSkillSources('https://gitlab.com/acme/tools.git@v2'), [
      { id: 'acme/tools', url: 'https://gitlab.com/acme/tools.git', ref: 'v2' }
    ]);
    assert.deepEqual(parseSkillSources(''), []);
  });
});
