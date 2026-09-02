/**
 * Sonda manual del adaptador de OpenHands.
 *
 *   # contra el doble (no requiere instalar OpenHands):
 *   printf '#!/bin/sh\nexec python3 %s "$@"\n' "$PWD/scripts/probe/fake-openhands.py" > /tmp/openhands && chmod +x /tmp/openhands
 *   OPENHANDS_COMMAND=/tmp/openhands npx ts-node scripts/probe/openhands.ts
 *
 *   # contra el CLI real:
 *   OPENHANDS_MODEL=gemini/gemini-2.5-flash OPENHANDS_API_KEY=... PROBE_WORKSPACE=/ruta npx ts-node scripts/probe/openhands.ts
 *
 * Ejecuta tres escenarios: sin modelo (settings del usuario), con modelo por
 * entorno, y con modelo pero sin clave (debe rechazarse antes de ejecutar).
 */
import { OpenHandsAdapter } from '../../src/adapters/openhands';

const base = {
  command: process.env.OPENHANDS_COMMAND || 'openhands',
  baseUrl: process.env.OPENHANDS_BASE_URL || '',
  timeoutMs: 300_000
};

const task = {
  conversationId: 'probe',
    skills: [],
  turn: 1,
  phase: 'DEVELOPMENT' as const,
  orchestrationMode: 'manual' as const,
  projectPath: process.env.PROBE_WORKSPACE || process.cwd(),
  prompt: 'En calc.py la función suma resta en vez de sumar.\nCorrígelo y ejecuta npm test.'
};

(async () => {
  const scenarios: Array<[string, { model: string; apiKey: string }]> = [
    ['A) sin modelo → usa settings guardados de OpenHands', { model: '', apiKey: '' }],
    ['B) modelo + clave por entorno', { model: process.env.OPENHANDS_MODEL || 'gemini/gemini-2.5-flash', apiKey: process.env.OPENHANDS_API_KEY || 'fake-key' }],
    ['C) modelo sin clave → debe rechazarse sin ejecutar', { model: 'gemini/gemini-2.5-flash', apiKey: '' }]
  ];

  for (const [name, overrides] of scenarios) {
    const adapter = new OpenHandsAdapter({ ...base, ...overrides });
    console.log(`\n================ ${name} ================`);
    console.log('status:', JSON.stringify(await adapter.getStatus()));
    console.log(await adapter.sendMessage(task));
  }
})();
