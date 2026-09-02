/**
 * Pruebas de integración del orquestador con adaptadores falsos.
 * No requieren red ni herramientas instaladas.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Orchestrator } from '../src/core/orchestrator';
import { HistoryWriter } from '../src/core/history-writer';
import { AgentRegistry } from '../src/agents/registry';
import { AgentAdapter, AgentTask, AgentType, ServerEvent } from '../src/types';

/** Adaptador de prueba: responde con una función y registra las tareas recibidas. */
class FakeAdapter implements AgentAdapter {
  tasks: AgentTask[] = [];
  constructor(private readonly reply: (task: AgentTask, call: number) => string | Promise<string>) {}
  async sendMessage(task: AgentTask): Promise<string> {
    this.tasks.push(task);
    return this.reply(task, this.tasks.length);
  }
  async getStatus() { return { available: true, mode: 'fake' }; }
  getSourceBackend() { return 'fake'; }
}

function setup(adapters: Partial<Record<AgentType, FakeAdapter>>) {
  const registry = new AgentRegistry();
  for (const [type, adapter] of Object.entries(adapters)) {
    registry.register(type as AgentType, adapter!);
  }
  const history = new HistoryWriter(mkdtempSync(join(tmpdir(), 'bridge-test-')));
  const orchestrator = new Orchestrator({ registry, history, defaults: { maxTurns: 10, delayBetweenTurnsMs: 0, autoStopOnError: false } });
  const events: ServerEvent[] = [];
  orchestrator.on('event', (e: ServerEvent) => events.push(e));
  return { orchestrator, events, registry };
}

/** Espera hasta que la conversación deje de estar en ejecución. */
async function waitForIdle(orchestrator: Orchestrator, id: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (orchestrator.isRunning(id)) {
    if (Date.now() > deadline) throw new Error('timeout esperando al ciclo');
    await new Promise(r => setTimeout(r, 5));
  }
}

describe('Orchestrator', () => {
  test('alterna agentes en round-robin y cierra cuando el arquitecto aprueba', async () => {
    const architect = new FakeAdapter((_t, call) => call === 1 ? '## Plan\nHaz X' : 'Bien.\nVEREDICTO: APROBADO');
    const dev = new FakeAdapter(() => 'Hecho X');
    const { orchestrator, events } = setup({ antigravity: architect, opencode: dev });

    const conv = orchestrator.createConversation({ title: 'Test', agentIds: ['antigravity', 'opencode'] });
    orchestrator.startLoop(conv.id, 'Objetivo');
    await waitForIdle(orchestrator, conv.id);

    assert.equal(conv.status, 'completed');
    assert.equal(conv.phase, 'COMPLETED');
    assert.equal(conv.currentTurn, 3); // plan, dev, review
    assert.deepEqual(conv.messages.map(m => m.agentId), ['user', 'antigravity', 'opencode', 'antigravity']);
    assert.equal(conv.messages.at(-1)?.metadata?.verdict, 'APPROVED');
    assert.equal(conv.messages.at(-1)?.metadata?.goalReached, true);

    const phases = events.filter(e => e.type === 'phase_change').map(e => (e as any).data.phase);
    assert.deepEqual(phases, ['DEVELOPMENT', 'REVIEW', 'COMPLETED']);
  });

  test('con REQUIERE_CAMBIOS sigue iterando hasta maxTurns', async () => {
    const architect = new FakeAdapter((_t, call) => call === 1 ? 'Plan' : 'Falta Y.\nVEREDICTO: REQUIERE_CAMBIOS');
    const dev = new FakeAdapter(() => 'Intento');
    const { orchestrator } = setup({ antigravity: architect, opencode: dev });

    const conv = orchestrator.createConversation({ title: 'Loop', agentIds: ['antigravity', 'opencode'], maxTurns: 4 });
    orchestrator.startLoop(conv.id, 'Objetivo');
    await waitForIdle(orchestrator, conv.id);

    assert.equal(conv.status, 'completed');
    assert.equal(conv.currentTurn, 4);
    assert.notEqual(conv.phase, 'COMPLETED');
    assert.match(conv.messages.at(-1)!.content, /máximo de 4 turnos/);
  });

  test('en modo autónomo el arquitecto redefine el equipo con [EQUIPO: ...]', async () => {
    const architect = new FakeAdapter((_t, call) => call === 1 ? '[EQUIPO: openhands, interpreter]\nPlan' : 'VEREDICTO: APROBADO');
    const opencode = new FakeAdapter(() => 'no debería ser llamado');
    const openhands = new FakeAdapter(() => 'implementado');
    const interpreter = new FakeAdapter(() => 'tests ok');
    const { orchestrator } = setup({ antigravity: architect, opencode, openhands, interpreter });

    const conv = orchestrator.createConversation({ title: 'Auto', orchestrationMode: 'autonomous' });
    assert.deepEqual(conv.agents, ['antigravity', 'opencode']); // equipo por defecto antes del turno 0

    orchestrator.startLoop(conv.id, 'Objetivo');
    await waitForIdle(orchestrator, conv.id);

    assert.deepEqual(conv.agents, ['antigravity', 'openhands', 'interpreter']);
    assert.equal(opencode.tasks.length, 0);
    assert.equal(openhands.tasks.length, 1);
    assert.equal(interpreter.tasks.length, 1);
    assert.ok(conv.messages.some(m => m.role === 'system' && /definió el equipo/.test(m.content)));
  });

  test('el arquitecto siempre se añade al equipo aunque no se pida', () => {
    const { orchestrator } = setup({ antigravity: new FakeAdapter(() => ''), aider: new FakeAdapter(() => '') });
    const conv = orchestrator.createConversation({ title: 'x', agentIds: ['aider'] });
    assert.deepEqual(conv.agents, ['antigravity', 'aider']);
  });

  test('pausar detiene el ciclo tras el turno en curso y reanudar continúa sin solapar', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const architect = new FakeAdapter(async (_t, call) => {
      if (call === 1) { await gate; return 'Plan'; }
      return 'VEREDICTO: APROBADO';
    });
    const dev = new FakeAdapter(() => 'ok');
    const { orchestrator } = setup({ antigravity: architect, opencode: dev });

    const conv = orchestrator.createConversation({ title: 'Pause', agentIds: ['antigravity', 'opencode'] });
    orchestrator.startLoop(conv.id, 'Objetivo');
    orchestrator.pauseLoop(conv.id);         // el turno 0 sigue en curso (bloqueado en `gate`)
    assert.equal(conv.status, 'paused');

    release();
    await waitForIdle(orchestrator, conv.id);
    assert.equal(conv.status, 'paused');
    assert.equal(conv.currentTurn, 1);       // solo se completó el turno en curso

    orchestrator.resumeLoop(conv.id);
    assert.throws(() => orchestrator.resumeLoop(conv.id), /ya está en ejecución/);
    await waitForIdle(orchestrator, conv.id);
    assert.equal(conv.status, 'completed');
    assert.equal(conv.currentTurn, 3);
  });

  test('reanudar antes de que termine el turno en curso cancela la pausa sin duplicar el ciclo', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const architect = new FakeAdapter(async (_t, call) => {
      if (call === 1) { await gate; return 'Plan'; }
      return 'VEREDICTO: APROBADO';
    });
    const dev = new FakeAdapter(() => 'ok');
    const { orchestrator } = setup({ antigravity: architect, opencode: dev });

    const conv = orchestrator.createConversation({ title: 'PauseResume', agentIds: ['antigravity', 'opencode'] });
    orchestrator.startLoop(conv.id, 'Objetivo');
    orchestrator.pauseLoop(conv.id);
    orchestrator.resumeLoop(conv.id);        // pausa cancelada mientras el turno 0 sigue en curso
    assert.equal(conv.status, 'active');

    release();
    await waitForIdle(orchestrator, conv.id);
    assert.equal(conv.status, 'completed');
    assert.equal(conv.currentTurn, 3);
    assert.equal(architect.tasks.length, 2); // sin turnos duplicados
    assert.equal(dev.tasks.length, 1);
  });

  test('un adaptador que lanza no tumba el ciclo si autoStopOnError=false', async () => {
    const architect = new FakeAdapter((_t, call) => call === 1 ? 'Plan' : 'VEREDICTO: APROBADO');
    const dev = new FakeAdapter(() => { throw new Error('boom'); });
    const { orchestrator } = setup({ antigravity: architect, opencode: dev });

    const conv = orchestrator.createConversation({ title: 'Err', agentIds: ['antigravity', 'opencode'] });
    orchestrator.startLoop(conv.id, 'Objetivo');
    await waitForIdle(orchestrator, conv.id);

    assert.equal(conv.status, 'completed');
    assert.ok(conv.messages.some(m => m.role === 'system' && /boom/.test(m.content)));
  });

  test('no permite iniciar dos ciclos a la vez ni reiniciar una conversación completada', async () => {
    const architect = new FakeAdapter((_t, call) => call === 1 ? 'Plan' : 'VEREDICTO: APROBADO');
    const { orchestrator } = setup({ antigravity: architect, opencode: new FakeAdapter(() => 'ok') });
    const conv = orchestrator.createConversation({ title: 'Dup', agentIds: ['antigravity', 'opencode'] });

    orchestrator.startLoop(conv.id, 'a');
    assert.throws(() => orchestrator.startLoop(conv.id, 'b'), /Ya hay un ciclo/);
    await waitForIdle(orchestrator, conv.id);
    assert.throws(() => orchestrator.startLoop(conv.id, 'c'), /completada/);
    assert.throws(() => orchestrator.resumeLoop(conv.id), /completada/);
  });

  test('[SIGUIENTE: id] en la revisión salta el round-robin y lo realinea', async () => {
    // Equipo: antigravity → opencode → aider → interpreter. Tras la primera revisión el
    // arquitecto manda directamente a aider; después el orden continúa desde aider.
    const architect = new FakeAdapter((_t, call) => {
      if (call === 1) return 'Plan';
      if (call === 2) return 'Falta Y.\nVEREDICTO: REQUIERE_CAMBIOS\n[SIGUIENTE: aider]';
      return 'VEREDICTO: APROBADO';
    });
    const opencode = new FakeAdapter(() => 'oc');
    const aider = new FakeAdapter(() => 'ai');
    const interpreter = new FakeAdapter(() => 'in');
    const { orchestrator } = setup({ antigravity: architect, opencode, aider, interpreter });

    const conv = orchestrator.createConversation({ title: 'Next', agentIds: ['antigravity', 'opencode', 'aider', 'interpreter'], maxTurns: 20 });
    orchestrator.startLoop(conv.id, 'Objetivo');
    await waitForIdle(orchestrator, conv.id);

    const order = conv.messages.filter(m => m.role === 'agent').map(m => m.agentId);
    // t0 antigravity, t1 opencode, t2 aider, t3 interpreter, t4 antigravity(REQUIERE_CAMBIOS → aider),
    // t5 aider, t6 interpreter, t7 antigravity(APROBADO)
    assert.deepEqual(order, ['antigravity', 'opencode', 'aider', 'interpreter', 'antigravity', 'aider', 'interpreter', 'antigravity']);
    assert.equal(conv.status, 'completed');
    assert.equal(conv.nextAgentId, undefined);
  });

  test('[SIGUIENTE] apuntando a un agente fuera del equipo se ignora', async () => {
    const architect = new FakeAdapter((_t, call) => call === 1 ? 'Plan' : call === 2 ? 'VEREDICTO: REQUIERE_CAMBIOS\n[SIGUIENTE: aider]' : 'VEREDICTO: APROBADO');
    const opencode = new FakeAdapter(() => 'oc');
    const { orchestrator } = setup({ antigravity: architect, opencode, aider: new FakeAdapter(() => 'nunca') });
    const conv = orchestrator.createConversation({ title: 'NextOut', agentIds: ['antigravity', 'opencode'], maxTurns: 10 });
    orchestrator.startLoop(conv.id, 'Objetivo');
    await waitForIdle(orchestrator, conv.id);
    assert.deepEqual(conv.messages.filter(m => m.role === 'agent').map(m => m.agentId), ['antigravity', 'opencode', 'antigravity', 'opencode', 'antigravity']);
  });

  test('stopTurn interrumpe al agente en curso, guarda su respuesta parcial y deja la sesión en pausa', async () => {
    // Adaptador que respeta la señal como haría una CLI: resuelve al abortar con salida parcial.
    const slow = new FakeAdapter((task) => new Promise<string>((resolve) => {
      task.signal!.addEventListener('abort', () => resolve('⏹️ parcial'), { once: true });
    }));
    const architect = new FakeAdapter((_t, call) => call === 1 ? 'Plan' : 'VEREDICTO: APROBADO');
    const { orchestrator, events } = setup({ antigravity: architect, opencode: slow });

    const conv = orchestrator.createConversation({ title: 'Stop', agentIds: ['antigravity', 'opencode'] });
    assert.throws(() => orchestrator.stopTurn(conv.id), /ningún turno/);
    orchestrator.startLoop(conv.id, 'Objetivo');
    // esperar a que el turno de opencode esté en curso
    while (slow.tasks.length === 0) await new Promise(r => setTimeout(r, 5));

    orchestrator.stopTurn(conv.id);
    await waitForIdle(orchestrator, conv.id);

    assert.equal(conv.status, 'paused');
    assert.equal(conv.currentTurn, 2);                       // el turno interrumpido cuenta como ejecutado
    assert.equal(conv.messages.at(-1)?.content, '⏹️ parcial'); // la salida parcial se conserva
    assert.ok(events.some(e => e.type === 'status' && (e as any).data.status === 'paused'));

    orchestrator.resumeLoop(conv.id);
    await waitForIdle(orchestrator, conv.id);
    assert.equal(conv.status, 'completed');
  });

  test('stopTurn con un adaptador que lanza al abortar deja un mensaje de sistema y no cuenta como error', async () => {
    const throwing = new FakeAdapter((task) => new Promise<string>((_resolve, reject) => {
      task.signal!.addEventListener('abort', () => reject(new Error('AbortError')), { once: true });
    }));
    const { orchestrator } = setup({ antigravity: new FakeAdapter(() => 'Plan'), opencode: throwing });
    const conv = orchestrator.createConversation({ title: 'StopThrow', agentIds: ['antigravity', 'opencode'] });
    orchestrator.startLoop(conv.id, 'Objetivo');
    while (throwing.tasks.length === 0) await new Promise(r => setTimeout(r, 5));
    orchestrator.stopTurn(conv.id);
    await waitForIdle(orchestrator, conv.id);
    assert.equal(conv.status, 'paused');
    assert.match(conv.messages.at(-1)!.content, /detenido por el usuario/);
  });

  test('el progreso del agente se reenvía como eventos turn_output', async () => {
    const chatty = new FakeAdapter((task) => { task.onProgress?.('a'); task.onProgress?.('b'); return 'ok'; });
    const architect = new FakeAdapter((_t, call) => call === 1 ? 'Plan' : 'VEREDICTO: APROBADO');
    const { orchestrator, events } = setup({ antigravity: architect, opencode: chatty });
    const conv = orchestrator.createConversation({ title: 'Progress', agentIds: ['antigravity', 'opencode'] });
    orchestrator.startLoop(conv.id, 'Objetivo');
    await waitForIdle(orchestrator, conv.id);
    const chunks = events.filter(e => e.type === 'turn_output').map(e => (e as any).data.chunk);
    assert.deepEqual(chunks, ['a', 'b']);
  });

  test('deleteConversation borra la sesión, emite el evento y aborta el turno en curso', async () => {
    const slow = new FakeAdapter((task) => new Promise<string>((resolve) => {
      task.signal!.addEventListener('abort', () => resolve('parcial'), { once: true });
    }));
    const { orchestrator, events } = setup({ antigravity: new FakeAdapter(() => 'Plan'), opencode: slow });
    const conv = orchestrator.createConversation({ title: 'Delete', agentIds: ['antigravity', 'opencode'] });
    orchestrator.startLoop(conv.id, 'Objetivo');
    while (slow.tasks.length === 0) await new Promise(r => setTimeout(r, 5));

    orchestrator.deleteConversation(conv.id);
    assert.equal(orchestrator.getConversation(conv.id), undefined);
    assert.ok(events.some(e => e.type === 'conversation_deleted'));
    await waitForIdle(orchestrator, conv.id);
    assert.equal(orchestrator.listConversations().length, 0);
    assert.throws(() => orchestrator.deleteConversation(conv.id), /no encontrada/);
  });

  test('el prompt que recibe cada agente incluye el workspace y el objetivo', async () => {
    const architect = new FakeAdapter((_t, call) => call === 1 ? 'Plan' : 'VEREDICTO: APROBADO');
    const dev = new FakeAdapter(() => 'ok');
    const { orchestrator } = setup({ antigravity: architect, opencode: dev });
    const conv = orchestrator.createConversation({ title: 'Ctx', agentIds: ['antigravity', 'opencode'], projectPath: '"/tmp/mi proyecto"' });
    orchestrator.startLoop(conv.id, 'Construir CLI');
    await waitForIdle(orchestrator, conv.id);

    assert.equal(conv.projectPath, '/tmp/mi proyecto'); // comillas eliminadas
    assert.equal(dev.tasks[0].projectPath, '/tmp/mi proyecto');
    assert.match(dev.tasks[0].prompt, /Construir CLI/);
    assert.match(dev.tasks[0].prompt, /Plan/);
  });
});
