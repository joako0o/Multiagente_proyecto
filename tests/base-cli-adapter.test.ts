/**
 * BaseCliAdapter con un comando real (node) en vez de una herramienta externa:
 * cubre cabecera, caché de estado, no instalado, mal configurado, timeout,
 * aborto, código de salida ≠ 0 y avisos ⚠️ de las subclases.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BaseCliAdapter, CliInvocation } from '../src/adapters/base-cli-adapter';
import { AgentTask } from '../src/types';
import { RunResult } from '../src/utils/shell';

const node = process.execPath;

/** Adaptador mínimo: ejecuta `node -e <script>` donde el script es el prompt. */
class NodeAdapter extends BaseCliAdapter {
  problem?: string;
  constructor(command = node, timeoutMs = 10_000) { super('🧪 Node', command, timeoutMs); }
  getSourceBackend() { return 'node'; }
  protected buildInvocation(task: AgentTask): CliInvocation {
    return { command: this.command, args: ['-e', task.prompt], env: { PROBE_VAR: 'hola' } };
  }
  protected configurationProblem() { return this.problem; }
  protected extractAnswer(result: RunResult): string {
    if (/SETTINGS_MISSING/.test(result.stdout)) return '⚠️ Falta configuración específica de la herramienta.';
    return result.stdout.trim();
  }
}

function task(prompt: string, extra: Partial<AgentTask> = {}): AgentTask {
  return { conversationId: 'c', prompt, skills: [], projectPath: process.cwd(), phase: 'DEVELOPMENT', orchestrationMode: 'manual', turn: 1, ...extra };
}

describe('BaseCliAdapter', () => {
  test('getStatus detecta el comando y cachea el resultado', async () => {
    const a = new NodeAdapter();
    const s1 = await a.getStatus();
    assert.equal(s1.available, true);
    assert.equal(s1.mode, 'cli');
    assert.match(s1.detail!, /^v\d+/);
    assert.equal(await a.getStatus(), s1); // misma referencia: cacheado
  });

  test('comando inexistente → no disponible, y sendMessage devuelve aviso sin lanzar', async () => {
    const a = new NodeAdapter('herramienta-inexistente-xyz');
    assert.equal((await a.getStatus()).mode, 'missing');
    const out = await a.sendMessage(task('1'));
    assert.match(out, /no disponible/);
    assert.match(out, /no está instalado/);
  });

  test('problema de configuración → misconfigured y turno saltado con explicación', async () => {
    const a = new NodeAdapter();
    a.problem = 'falta la clave';
    assert.deepEqual(await a.getStatus(), { available: false, mode: 'misconfigured', detail: 'falta la clave' });
    assert.match(await a.sendMessage(task('1')), /falta la clave/);
  });

  test('respuesta correcta: cabecera con comando, workspace, duración, código y el stdout', async () => {
    const out = await new NodeAdapter().sendMessage(task('process.stdout.write("hola " + process.env.PROBE_VAR)'));
    assert.match(out, /\*\*Comando:\*\* `.*node -e/);
    assert.match(out, /\*\*Workspace:\*\* `/);
    assert.match(out, /\*\*Código de salida:\*\* 0/);
    assert.match(out, /hola hola$/);
  });

  test('argumentos largos se acortan en la cabecera (el prompt no se vuelca entero)', async () => {
    const long = 'process.stdout.write("x")' + ' '.repeat(200);
    const out = await new NodeAdapter().sendMessage(task(long));
    assert.ok(!out.includes(long));
    assert.match(out, /\.\.\."/);
  });

  test('código de salida ≠ 0 → aviso con stderr en bloque', async () => {
    const out = await new NodeAdapter().sendMessage(task('process.stderr.write("boom"); process.exit(2)'));
    assert.match(out, /terminó con error/);
    assert.match(out, /```text\nboom\n```/);
    assert.match(out, /\*\*Código de salida:\*\* 2/);
  });

  test('sin salida → texto explicativo', async () => {
    assert.match(await new NodeAdapter().sendMessage(task('0')), /sin producir texto/);
  });

  test('timeout → aviso con salida parcial', async () => {
    const out = await new NodeAdapter(node, 300).sendMessage(task('process.stdout.write("parcial"); setTimeout(()=>{}, 60000)'));
    assert.match(out, /Tiempo agotado/);
    assert.match(out, /parcial/);
  });

  test('aborto por el usuario → aviso ⏹️ con salida parcial y sin reintentos', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const out = await new NodeAdapter().sendMessage(task('process.stdout.write("hasta aquí"); setTimeout(()=>{}, 60000)', { signal: controller.signal }));
    assert.match(out, /detenido por el usuario/);
    assert.match(out, /hasta aquí/);
  });

  test('onProgress recibe la salida en vivo', async () => {
    const chunks: string[] = [];
    await new NodeAdapter().sendMessage(task('process.stdout.write("a"); setTimeout(()=>process.stdout.write("b"), 30)', { onProgress: c => chunks.push(c) }));
    assert.deepEqual(chunks, ['a', 'b']);
  });

  test('un aviso ⚠️ de la subclase se muestra tal cual aunque el proceso falle', async () => {
    const out = await new NodeAdapter().sendMessage(task('process.stdout.write("SETTINGS_MISSING"); process.exit(1)'));
    assert.match(out, /⚠️ Falta configuración específica/);
    assert.doesNotMatch(out, /terminó con error/);
  });
});
