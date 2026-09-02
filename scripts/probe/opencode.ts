/**
 * Sonda manual del adaptador de OpenCode contra un servidor real.
 *
 *   opencode serve --port 4096                      # terminal 1
 *   OPENCODE_PROVIDER=google OPENCODE_MODEL=gemini-2.5-flash PROBE_WORKSPACE=/ruta \
 *     npx ts-node scripts/probe/opencode.ts         # terminal 2
 *
 * Para probar sin gastar cuota, arranca `python scripts/probe/fake-llm.py` y
 * declara el proveedor en el `opencode.json` del workspace:
 *   { "provider": { "fakellm": { "npm": "@ai-sdk/openai-compatible",
 *     "options": { "baseURL": "http://127.0.0.1:11500/v1", "apiKey": "fake" },
 *     "models": { "fake": {} } } } }
 * y usa OPENCODE_PROVIDER=fakellm OPENCODE_MODEL=fake.
 */
import { OpenCodeAdapter } from '../../src/adapters/opencode';

(async () => {
  const adapter = new OpenCodeAdapter({
    url: process.env.OPENCODE_URL || 'http://127.0.0.1:4096',
    providerID: process.env.OPENCODE_PROVIDER || 'fakellm',
    modelID: process.env.OPENCODE_MODEL || 'fake',
    autoStart: false,
    timeoutMs: 180_000
  });

  console.log('status:', JSON.stringify(await adapter.getStatus()));
  const out = await adapter.sendMessage({
    conversationId: 'probe',
    skills: [],
    turn: 1,
    phase: 'DEVELOPMENT',
    orchestrationMode: 'manual',
    projectPath: process.env.PROBE_WORKSPACE || process.cwd(),
    prompt: 'En calc.py la función suma resta en vez de sumar. Corrígelo.'
  });
  console.log('\n===== RESPUESTA DEL ADAPTADOR =====\n' + out);
})();
