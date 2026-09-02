/**
 * Sonda manual del adaptador de Aider contra una instalación real.
 *
 *   # terminal 1: LLM falso (o usa un modelo real vía variables)
 *   python scripts/probe/fake-llm.py
 *   # terminal 2
 *   AIDER_COMMAND=/ruta/venv/bin/aider PROBE_WORKSPACE=/ruta/repo npx ts-node scripts/probe/aider.ts
 *
 * El workspace debe ser un repo git con un `calc.py` que reste en `suma`
 * (es lo que el LLM falso "corrige"). Variables: AIDER_COMMAND, AIDER_MODEL,
 * AIDER_API_KEY, AIDER_BASE_URL, PROBE_WORKSPACE.
 */
import { AiderAdapter } from '../../src/adapters/aider';

(async () => {
  const adapter = new AiderAdapter({
    command: process.env.AIDER_COMMAND || 'aider',
    model: process.env.AIDER_MODEL || 'openai/fake',
    apiKey: process.env.AIDER_API_KEY || 'openai=fake',
    baseUrl: process.env.AIDER_BASE_URL || 'http://127.0.0.1:11500/v1',
    autoCommits: false,
    timeoutMs: 120_000
  });

  console.log('status:', JSON.stringify(await adapter.getStatus()));
  const out = await adapter.sendMessage({
    conversationId: 'probe',
    turn: 1,
    phase: 'DEVELOPMENT',
    orchestrationMode: 'manual',
    projectPath: process.env.PROBE_WORKSPACE || process.cwd(),
    prompt: 'En calc.py la función suma resta en vez de sumar. Corrígelo. Archivo: calc.py'
  });
  console.log('\n===== RESPUESTA DEL ADAPTADOR =====\n' + out);
})();
