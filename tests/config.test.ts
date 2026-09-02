import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  test('aplica valores por defecto con entorno vacío', () => {
    const cfg = loadConfig({});
    assert.equal(cfg.server.port, 3000);
    assert.equal(cfg.antigravity.provider, 'gemini');
    assert.equal(cfg.opencode.url, 'http://127.0.0.1:4096');
    assert.equal(cfg.opencode.autoStart, true);
    assert.equal(cfg.loop.maxTurns, 15);
  });

  test('GEMINI_API_KEY se propaga a los agentes que pueden usar Gemini', () => {
    const cfg = loadConfig({ GEMINI_API_KEY: 'abc' });
    assert.equal(cfg.antigravity.apiKey, 'abc');
    assert.equal(cfg.openhands.apiKey, 'abc');
    assert.equal(cfg.openhands.model, 'gemini/gemini-2.5-flash');
    assert.equal(cfg.aider.model, 'gemini/gemini-2.5-flash');
  });

  test('las variables específicas tienen prioridad sobre las genéricas', () => {
    const cfg = loadConfig({ GEMINI_API_KEY: 'abc', ANTIGRAVITY_API_KEY: 'xyz', AIDER_MODEL: 'ollama/qwen' });
    assert.equal(cfg.antigravity.apiKey, 'xyz');
    assert.equal(cfg.aider.model, 'ollama/qwen');
  });

  test('parsea enteros y booleanos de forma tolerante', () => {
    const cfg = loadConfig({ PORT: 'abc', OPENCODE_AUTO_START: 'no', AIDER_AUTO_COMMITS: 'TRUE' });
    assert.equal(cfg.server.port, 3000);
    assert.equal(cfg.opencode.autoStart, false);
    assert.equal(cfg.aider.autoCommits, true);
  });

  test('las fuentes de skills por defecto son varias y se pueden sustituir', () => {
    const ids = loadConfig({}).skills.sources.map(s => s.id);
    assert.ok(ids.includes('anthropics/skills'));
    assert.ok(ids.includes('bytedance/deer-flow'));
    assert.deepEqual(loadConfig({ SKILLS_SOURCES: 'acme/one' }).skills.sources.map(s => s.id), ['acme/one']);
  });

  test('normaliza la URL de OpenCode sin barra final', () => {
    assert.equal(loadConfig({ OPENCODE_URL: 'http://localhost:4096/' }).opencode.url, 'http://localhost:4096');
  });
});
