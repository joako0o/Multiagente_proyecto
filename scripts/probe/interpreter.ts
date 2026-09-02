/**
 * Sonda manual del adaptador de Open Interpreter contra una instalación real.
 *
 *   # terminal 1: LLM falso (o usa un modelo real vía variables)
 *   python scripts/probe/fake-llm.py
 *   # terminal 2
 *   INTERPRETER_PYTHON=/ruta/venv/bin/python PROBE_WORKSPACE=/ruta/proyecto npx ts-node scripts/probe/interpreter.ts
 *
 * Variables: INTERPRETER_PYTHON, INTERPRETER_COMMAND, INTERPRETER_MODEL,
 * INTERPRETER_API_BASE, INTERPRETER_API_KEY, PROBE_WORKSPACE.
 */
import { InterpreterAdapter } from '../../src/adapters/interpreter';

(async () => {
  const adapter = new InterpreterAdapter({
    python: process.env.INTERPRETER_PYTHON || 'python3',
    command: process.env.INTERPRETER_COMMAND || 'interpreter',
    model: process.env.INTERPRETER_MODEL || 'openai/fake',
    apiBase: process.env.INTERPRETER_API_BASE || 'http://127.0.0.1:11500/v1',
    apiKey: process.env.INTERPRETER_API_KEY || 'fake',
    contextWindow: 32_000,
    maxTokens: 4_000,
    timeoutMs: 180_000
  });

  console.log('status:', JSON.stringify(await adapter.getStatus()));
  const out = await adapter.sendMessage({
    conversationId: 'probe',
    turn: 2,
    phase: 'EXECUTION',
    orchestrationMode: 'manual',
    projectPath: process.env.PROBE_WORKSPACE || process.cwd(),
    prompt: 'Verifica que el proyecto tiene tests\ny ejecútalos.\n\nReporta el resultado real.'
  });
  console.log('\n===== RESPUESTA DEL ADAPTADOR =====\n' + out);
})();
