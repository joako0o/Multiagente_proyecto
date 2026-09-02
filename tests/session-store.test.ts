/**
 * Persistencia de sesiones: guardar, recuperar y comportamiento tras un "reinicio".
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore, reviveConversation } from '../src/core/session-store';
import { Orchestrator } from '../src/core/orchestrator';
import { HistoryWriter } from '../src/core/history-writer';
import { AgentRegistry } from '../src/agents/registry';
import { AgentAdapter, AgentTask, Conversation } from '../src/types';

class FakeAdapter implements AgentAdapter {
  constructor(private readonly reply: (task: AgentTask, call: number) => string | Promise<string>) {}
  calls = 0;
  async sendMessage(task: AgentTask) { return this.reply(task, ++this.calls); }
  async getStatus() { return { available: true, mode: 'fake' }; }
  getSourceBackend() { return 'fake'; }
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  const now = new Date('2026-01-02T03:04:05Z');
  return {
    id: 'abc', title: 'Demo', agents: ['antigravity', 'opencode'], status: 'active', phase: 'DEVELOPMENT',
    orchestrationMode: 'manual', projectPath: '/tmp/x', currentTurn: 2, maxTurns: 10, skills: { opencode: ['pdf'] },
    createdAt: now, updatedAt: now,
    messages: [{ id: 'm1', conversationId: 'abc', agentId: 'user', role: 'user', content: 'hola', timestamp: now }],
    ...overrides
  };
}

async function waitForIdle(o: Orchestrator, id: string) {
  const deadline = Date.now() + 5000;
  while (o.isRunning(id)) {
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise(r => setTimeout(r, 5));
  }
}

describe('SessionStore', () => {
  test('guarda y recupera con fechas reconstruidas; las activas vuelven en pausa', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sessions-'));
    const store = new SessionStore(dir);
    store.save(conversation());
    store.save(conversation({ id: 'def', status: 'completed', createdAt: new Date('2026-01-01T00:00:00Z') }));

    assert.deepEqual(readdirSync(dir).sort(), ['abc.json', 'def.json']);
    const loaded = store.loadAll();
    assert.deepEqual(loaded.map(c => c.id), ['def', 'abc']); // orden por createdAt

    const abc = loaded.find(c => c.id === 'abc')!;
    assert.equal(abc.status, 'paused');
    assert.ok(abc.createdAt instanceof Date);
    assert.ok(abc.messages[0].timestamp instanceof Date);
    assert.match(abc.messages.at(-1)!.content, /se reinició/);
    assert.deepEqual(abc.skills, { opencode: ['pdf'] });

    assert.equal(loaded.find(c => c.id === 'def')!.status, 'completed');
  });

  test('omite archivos corruptos y tolera sesiones de versiones antiguas sin `skills`', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sessions-'));
    writeFileSync(join(dir, 'bad.json'), '{ esto no es json');
    writeFileSync(join(dir, 'old.json'), JSON.stringify({ id: 'old', title: 'Vieja', agents: ['antigravity'], messages: [], status: 'idle', createdAt: '2025-01-01T00:00:00Z' }));
    const loaded = new SessionStore(dir).loadAll();
    assert.equal(loaded.length, 1);
    assert.deepEqual(loaded[0].skills, {});
    assert.equal(loaded[0].maxTurns, 15);
  });

  test('reviveConversation rechaza estructuras sin campos obligatorios', () => {
    assert.throws(() => reviveConversation({ id: 'x' }), /obligatorios/);
    assert.throws(() => reviveConversation('texto'), /objeto/);
  });

  test('delete borra el archivo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sessions-'));
    const store = new SessionStore(dir);
    store.save(conversation());
    store.delete('abc');
    assert.deepEqual(readdirSync(dir), []);
  });
});

describe('Orchestrator + SessionStore', () => {
  test('una sesión sobrevive a un "reinicio" y se puede reanudar hasta completarse', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sessions-'));
    const historyDir = mkdtempSync(join(tmpdir(), 'history-'));

    // Proceso 1: arranca el ciclo y "muere" tras el turno de planificación (pausa simulada).
    const registry1 = new AgentRegistry();
    registry1.register('antigravity', new FakeAdapter(() => 'Plan'));
    registry1.register('opencode', new FakeAdapter(() => 'ok'));
    const o1 = new Orchestrator({ registry: registry1, history: new HistoryWriter(historyDir), store: new SessionStore(dir), defaults: { maxTurns: 10, delayBetweenTurnsMs: 0, autoStopOnError: false } });
    const conv = o1.createConversation({ title: 'Persistente', agentIds: ['antigravity', 'opencode'] });
    o1.startLoop(conv.id, 'Objetivo');
    o1.pauseLoop(conv.id);
    await waitForIdle(o1, conv.id);
    assert.equal(conv.currentTurn, 1);

    // Proceso 2: nuevo orquestador sobre el mismo directorio.
    const registry2 = new AgentRegistry();
    registry2.register('antigravity', new FakeAdapter((_t, call) => call === 1 ? 'VEREDICTO: APROBADO' : 'x'));
    registry2.register('opencode', new FakeAdapter(() => 'implementado'));
    const o2 = new Orchestrator({ registry: registry2, history: new HistoryWriter(historyDir), store: new SessionStore(dir), defaults: { maxTurns: 10, delayBetweenTurnsMs: 0, autoStopOnError: false } });
    assert.equal(o2.restore(), 1);

    const restored = o2.getConversation(conv.id)!;
    assert.equal(restored.status, 'paused');
    assert.equal(restored.currentTurn, 1);
    assert.equal(restored.messages.length, 2); // user + plan

    o2.resumeLoop(conv.id);
    await waitForIdle(o2, conv.id);
    assert.equal(restored.status, 'completed');
    assert.deepEqual(restored.messages.map(m => m.agentId), ['user', 'antigravity', 'opencode', 'antigravity']);

    // El .json refleja el estado final.
    const again = new SessionStore(dir).loadAll();
    assert.equal(again[0].status, 'completed');
    assert.equal(again[0].currentTurn, 3);
  });
});
