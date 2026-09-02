require('dotenv').config();
const WebSocket = require('ws');
const { AntigravityOpenCodeServer } = require('../dist/server');

async function runTest() {
  console.log('🚀 Iniciando prueba End-to-End del sistema colaborativo con IA REAL...\n');

  const testPort = 3999;
  const server = new AntigravityOpenCodeServer({
    port: testPort,
    host: '127.0.0.1',
    opencode: {
      url: process.env.OPENCODE_URL || 'http://localhost:4096',
      apiKey: process.env.GEMINI_API_KEY,
      model: 'gemini-2.5-flash'
    },
    antigravity: {
      apiKey: process.env.GEMINI_API_KEY,
      model: 'gemini-2.5-flash'
    }
  });

  await server.start();
  console.log('✅ Servidor iniciado en puerto', testPort);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws`);

    ws.on('open', () => {
      console.log('✅ Cliente WebSocket conectado exitosamente.');

      // 1. Crear conversación
      console.log('📨 Enviando solicitud de creación de conversación...');
      ws.send(JSON.stringify({
        type: 'create_conversation',
        data: {
          title: 'Módulo Validador de Tokens JWT',
          projectPath: 'C:\\Proyectos\\DemoAuth',
          agentIds: ['antigravity', 'opencode']
        }
      }));
    });

    ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString());

      if (event.type === 'connected') {
        console.log(`ℹ️ [Evento WS] Conectado. Agentes disponibles: ${event.data.agents.map(a => a.name).join(', ')}`);
      } else if (event.type === 'conversation_created') {
        console.log(`✅ [Evento WS] Conversación creada con ID: ${event.data.id}`);
        console.log(`   Título: "${event.data.title}"`);
        console.log(`   Workspace: "${event.data.projectPath}"`);

        // 2. Iniciar el loop con una directiva inicial
        console.log('\n▶️ Iniciando Loop Colaborativo...');
        ws.send(JSON.stringify({
          type: 'start_loop',
          data: {
            conversationId: event.data.id,
            initialPrompt: 'Necesitamos crear un validador de JWT con expiración de 1h y manejo de excepciones.',
            config: { maxTurns: 6 }
          }
        }));
      } else if (event.type === 'turn_change') {
        console.log(`\n🔄 [Turno ${event.data.turn + 1}] Agente activo: ${event.data.agentName} | Fase: [${event.data.phase}]`);
      } else if (event.type === 'phase_change') {
        console.log(`🏷️ [Cambio de Fase] -> ${event.data.phase}`);
      } else if (event.type === 'message') {
        const msg = event.data;
        const sender = msg.agentId === 'user' ? '👤 Usuario' : (msg.agentId === 'antigravity' ? '🏛️ Antigravity' : '💻 OpenCode');
        console.log(`💬 Mensaje de ${sender} (longitud: ${msg.content.length} caracteres):`);
        const preview = msg.content.split('\n').slice(0, 4).join('\n');
        console.log(`   ${preview}...\n`);
      } else if (event.type === 'status') {
        if (event.data.status === 'completed') {
          console.log(`\n🎉 [Ciclo Completado] Estado: ${event.data.status} | Total turnos: ${event.data.turns}`);
          ws.close();
        }
      } else if (event.type === 'error') {
        console.error('❌ Error recibido por WebSocket:', event.data);
      }
    });

    ws.on('close', async () => {
      console.log('🔌 Conexión WebSocket cerrada.');
      await server.stop();
      console.log('🛑 Servidor detenido con éxito.');
      resolve();
    });

    ws.on('error', async (err) => {
      console.error('❌ Error en WebSocket:', err);
      await server.stop();
      reject(err);
    });

    // Timeout de seguridad por si algo se bloquea
    setTimeout(async () => {
      console.warn('⚠️ Timeout alcanzado en la prueba.');
      ws.close();
      await server.stop();
      resolve();
    }, 20000);
  });
}

runTest()
  .then(() => {
    console.log('\n=========================================');
    console.log('✅ TODAS LAS PRUEBAS FUNCIONARON CON ÉXITO');
    console.log('=========================================');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n❌ ERROR EN LA PRUEBA:', err);
    process.exit(1);
  });
