#!/usr/bin/env node
/**
 * Prueba end-to-end: levanta el servidor compilado, se conecta por WebSocket,
 * crea una sesión y ejecuta un ciclo corto, imprimiendo los eventos.
 *
 * Uso:
 *   npm run build && npm run test:e2e
 *
 * Variables opcionales:
 *   E2E_AGENTS      ids separados por coma (por defecto: antigravity,opencode)
 *   E2E_PROMPT      objetivo a enviar
 *   E2E_MAX_TURNS   turnos máximos (por defecto 4)
 *   E2E_TIMEOUT_MS  tiempo máximo de la prueba (por defecto 10 min)
 *
 * Requiere `.env` con las credenciales de los agentes que participen. Sin
 * GEMINI_API_KEY el arquitecto responderá "no configurado" y el ciclo seguirá
 * hasta agotar los turnos, lo que sigue siendo útil para probar la tubería.
 */
require('dotenv').config();
const WebSocket = require('ws');
const { loadConfig } = require('../dist/config');
const { BridgeServer } = require('../dist/server');

const PORT = 3999;
const agents = (process.env.E2E_AGENTS || 'antigravity,opencode').split(',').map(s => s.trim());
const prompt = process.env.E2E_PROMPT || 'Crea un archivo hello.js que imprima "hola" y un test que lo verifique.';
const maxTurns = Number(process.env.E2E_MAX_TURNS || 4);
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS || 10 * 60 * 1000);

async function main() {
  const config = loadConfig({ ...process.env, PORT: String(PORT), HOST: '127.0.0.1', LOOP_DELAY_MS: '500' });
  const server = new BridgeServer(config);
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const finished = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout de ${timeoutMs / 1000}s alcanzado`)), timeoutMs);

    ws.on('open', () => {
      console.log('✔ WebSocket conectado');
      ws.send(JSON.stringify({
        type: 'create_conversation',
        data: { title: 'E2E', agentIds: agents, orchestrationMode: 'manual', maxTurns, projectPath: process.cwd() }
      }));
    });

    ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      switch (event.type) {
        case 'connected':
          console.log(`✔ Agentes registrados: ${event.data.agents.map(a => a.id).join(', ')}`);
          break;
        case 'conversation_created':
          console.log(`✔ Sesión ${event.data.id} · equipo: ${event.data.agents.join(' → ')}`);
          ws.send(JSON.stringify({ type: 'start_loop', data: { conversationId: event.data.id, initialPrompt: prompt } }));
          break;
        case 'turn_change':
          console.log(`\n▶ Turno ${event.data.turn + 1} · ${event.data.agentName} · ${event.data.phase}`);
          break;
        case 'message':
          if (event.data.role !== 'user') {
            const preview = event.data.content.split('\n').slice(0, 3).join(' | ').slice(0, 160);
            console.log(`  ${event.data.agentId}: ${preview}${event.data.metadata?.verdict ? `  [${event.data.metadata.verdict}]` : ''}`);
          }
          break;
        case 'status':
          if (event.data.status === 'completed' || event.data.status === 'paused') {
            clearTimeout(timer);
            console.log(`\n■ Ciclo ${event.data.status} · ${event.data.turns} turnos · fase ${event.data.phase}`);
            resolve();
          }
          break;
        case 'error':
          console.error(`✖ ${event.data.message}`);
          break;
      }
    });

    ws.on('error', reject);
  });

  try {
    await finished;
  } finally {
    ws.close();
    await server.stop();
  }
}

main()
  .then(() => { console.log('\n✔ E2E completado'); process.exit(0); })
  .catch((err) => { console.error('\n✖ E2E falló:', err.message); process.exit(1); });
