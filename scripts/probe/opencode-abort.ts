/**
 * Comprueba que detener un turno de OpenCode cancela la petición y aborta la sesión en el servidor.
 *   opencode serve --port 4096   (con un proveedor configurado en el workspace)
 *   PROBE_WORKSPACE=/ruta npx ts-node scripts/probe/opencode-abort.ts
 */
import { OpenCodeAdapter } from '../../src/adapters/opencode';

(async () => {
  const adapter = new OpenCodeAdapter({
    url: process.env.OPENCODE_URL || 'http://127.0.0.1:4096',
    providerID: process.env.OPENCODE_PROVIDER || 'fakellm',
    modelID: process.env.OPENCODE_MODEL || 'fake',
    autoStart: false,
    timeoutMs: 120_000
  });
  const controller = new AbortController();
  setTimeout(() => { console.log('→ abort a los 300 ms'); controller.abort(); }, 300);
  const t0 = Date.now();
  const out = await adapter.sendMessage({
    conversationId: 'abort-probe', turn: 1, phase: 'DEVELOPMENT', orchestrationMode: 'manual', skills: [],
    projectPath: process.env.PROBE_WORKSPACE || process.cwd(),
    prompt: 'Escribe un ensayo muy largo.',
    signal: controller.signal
  });
  console.log(`respuesta tras ${Date.now() - t0} ms:`, out.slice(0, 120));
})();
