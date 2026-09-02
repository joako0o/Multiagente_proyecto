import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../src/core/prompt-builder';
import { AGENT_CATALOG } from '../src/agents/catalog';
import { Agent, AgentAdapter, Conversation } from '../src/types';

const dummyAdapter: AgentAdapter = {
  sendMessage: async () => '',
  getStatus: async () => ({ available: true, mode: 'test' }),
  getSourceBackend: () => 'test'
};

function agent(id: keyof typeof AGENT_CATALOG): Agent {
  return { ...AGENT_CATALOG[id], adapter: dummyAdapter };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1', title: 'Demo', agents: ['antigravity', 'opencode'], messages: [
      { id: 'm1', conversationId: 'c1', agentId: 'user', role: 'user', content: 'Crear una API', timestamp: new Date() }
    ],
    status: 'active', phase: 'PLANNING', orchestrationMode: 'manual', projectPath: '/tmp/demo',
    currentTurn: 0, maxTurns: 10, skills: {}, createdAt: new Date(), updatedAt: new Date(), ...overrides
  };
}

describe('buildPrompt', () => {
  test('incluye contexto, objetivo original e historial', () => {
    const prompt = buildPrompt({ conversation: conversation(), agent: agent('antigravity'), team: [agent('antigravity'), agent('opencode')], displayName: id => id });
    assert.match(prompt, /Workspace.*\/tmp\/demo/);
    assert.match(prompt, /Objetivo original del usuario\n\nCrear una API/);
    assert.match(prompt, /Turno:\*\* 1 de 10/);
  });

  test('en modo autónomo pide la etiqueta [EQUIPO: ...] con los ids disponibles', () => {
    const prompt = buildPrompt({ conversation: conversation({ orchestrationMode: 'autonomous' }), agent: agent('antigravity'), team: [agent('antigravity')], displayName: id => id });
    assert.match(prompt, /\[EQUIPO: id1, id2, \.\.\.\]/);
    assert.match(prompt, /`openhands`/);
    assert.match(prompt, /`interpreter`/);
  });

  test('en modo manual no pide elegir equipo', () => {
    const prompt = buildPrompt({ conversation: conversation(), agent: agent('antigravity'), team: [agent('antigravity'), agent('opencode')], displayName: id => id });
    assert.doesNotMatch(prompt, /\[EQUIPO/);
    assert.match(prompt, /El equipo ya está definido/);
  });

  test('el arquitecto en turno > 0 recibe instrucciones de revisión con la línea de veredicto', () => {
    const prompt = buildPrompt({ conversation: conversation({ currentTurn: 2, phase: 'REVIEW' }), agent: agent('antigravity'), team: [agent('antigravity'), agent('opencode')], displayName: id => id });
    assert.match(prompt, /VEREDICTO: APROBADO/);
    assert.match(prompt, /VEREDICTO: REQUIERE_CAMBIOS/);
  });

  test('cada tipo de agente recibe instrucciones propias', () => {
    for (const id of ['opencode', 'openhands', 'aider', 'interpreter'] as const) {
      const prompt = buildPrompt({ conversation: conversation({ currentTurn: 1 }), agent: agent(id), team: [agent('antigravity'), agent(id)], displayName: x => x });
      assert.match(prompt, new RegExp(`Eres \\*\\*${AGENT_CATALOG[id].name}\\*\\*`));
    }
  });

  test('recorta mensajes muy largos del historial', () => {
    const long = 'x'.repeat(10_000);
    const conv = conversation({ messages: [
      { id: 'm1', conversationId: 'c1', agentId: 'user', role: 'user', content: 'objetivo', timestamp: new Date() },
      { id: 'm2', conversationId: 'c1', agentId: 'opencode', role: 'agent', content: long, timestamp: new Date() }
    ] });
    const prompt = buildPrompt({ conversation: conv, agent: agent('antigravity'), team: [agent('antigravity')], displayName: x => x });
    assert.match(prompt, /mensaje recortado, 4000 caracteres más/);
  });
});
