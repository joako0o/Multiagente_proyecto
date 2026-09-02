/**
 * Muestra los prompts que genera el subsistema de skills, usando una biblioteca real:
 *  1. lo que ve el arquitecto en planificación (catálogo + formato de asignación),
 *  2. el dossier de un agente con soporte nativo (OpenCode),
 *  3. el dossier de un agente sin soporte nativo (Open Interpreter).
 *
 *   SKILLS_CACHE_DIR=/ruta/cache npx ts-node scripts/probe/skills-prompt.ts
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../../src/config';
import { SkillLibrary } from '../../src/skills/skill-library';
import { SkillCoordinator } from '../../src/skills/skill-coordinator';
import { createAgentRegistry } from '../../src/agents/registry';
import { Conversation } from '../../src/types';

(async () => {
  const config = loadConfig();
  const library = new SkillLibrary(config.skills.cacheDir, config.skills.sources);
  if (!library.list().length) {
    console.log('Biblioteca vacía; sincronizando…');
    console.log(await library.sync());
  }
  const skills = new SkillCoordinator(library);
  const registry = createAgentRegistry(config);

  const conversation: Conversation = {
    id: 'demo', title: 'Demo skills', agents: ['antigravity', 'opencode', 'interpreter'], messages: [],
    status: 'active', phase: 'PLANNING', orchestrationMode: 'autonomous',
    projectPath: mkdtempSync(join(tmpdir(), 'skills-prompt-')), currentTurn: 0, maxTurns: 10, skills: {},
    createdAt: new Date(), updatedAt: new Date()
  };

  const section = skills.sectionForArchitect(conversation);
  console.log('════════ 1) ARQUITECTO · sección de skills (' + section.length + ' caracteres) ════════\n');
  console.log(section.split('\n').slice(0, 14).join('\n') + '\n…\n');

  const [first, second] = library.list().map(s => s.name);
  skills.applyArchitectAssignments(conversation, `[SKILLS: opencode=${first}; interpreter=${second}]`, registry);
  console.log('asignación resultante:', JSON.stringify(conversation.skills), '\n');

  const native = skills.prepareTurn(conversation, registry.get('opencode')!);
  console.log('════════ 2) OPENCODE (carga nativa) · ' + native.length + ' caracteres ════════\n' + native + '\n');

  const inline = skills.prepareTurn(conversation, registry.get('interpreter')!);
  console.log('════════ 3) OPEN INTERPRETER (inyectado) · ' + inline.length + ' caracteres ════════\n' + inline.split('\n').slice(0, 30).join('\n') + '\n…');
})();
