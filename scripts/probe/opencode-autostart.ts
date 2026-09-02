/**
 * Comprueba que el adaptador levanta `opencode serve` solo si no hay servidor.
 *   PATH=/ruta/con/opencode:$PATH npx ts-node scripts/probe/opencode-autostart.ts
 */
import { OpenCodeAdapter } from '../../src/adapters/opencode';

(async () => {
  const adapter = new OpenCodeAdapter({ url: 'http://127.0.0.1:4097', providerID: 'fakellm', modelID: 'fake', autoStart: true, timeoutMs: 60_000 });
  console.log('antes:', JSON.stringify(await adapter.getStatus()));
  const out = await adapter.sendMessage({
    conversationId: 'auto',
    skills: [], turn: 1, phase: 'DEVELOPMENT', orchestrationMode: 'manual',
    projectPath: process.env.PROBE_WORKSPACE || process.cwd(), prompt: 'Di hola.'
  });
  console.log('respuesta:', out.slice(0, 120).replace(/\n/g, ' | '));
  console.log('después:', JSON.stringify(await adapter.getStatus()));
})();
