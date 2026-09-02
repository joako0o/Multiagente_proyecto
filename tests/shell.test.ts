/**
 * Ejecución de procesos: cancelación por señal y salida en vivo.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { run, CommandNotFoundError, commandExists } from '../src/utils/shell';

const node = process.execPath;

describe('run', () => {
  test('captura stdout/stderr, código de salida y duración', async () => {
    const r = await run(node, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)']);
    assert.equal(r.stdout, 'out');
    assert.equal(r.stderr, 'err');
    assert.equal(r.exitCode, 3);
    assert.equal(r.timedOut, false);
    assert.equal(r.aborted, false);
    assert.ok(r.durationMs >= 0);
  });

  test('onOutput recibe los fragmentos según llegan', async () => {
    const seen: string[] = [];
    await run(node, ['-e', 'process.stdout.write("1"); setTimeout(() => process.stdout.write("2"), 50)'], {
      onOutput: (chunk, stream) => seen.push(`${stream}:${chunk}`)
    });
    assert.deepEqual(seen, ['stdout:1', 'stdout:2']);
  });

  test('la señal de aborto mata el proceso y marca aborted', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const r = await run(node, ['-e', 'process.stdout.write("empiezo"); setTimeout(() => {}, 60_000)'], { signal: controller.signal, timeoutMs: 30_000 });
    assert.equal(r.aborted, true);
    assert.equal(r.timedOut, false);
    assert.equal(r.stdout, 'empiezo');
    assert.ok(Date.now() - started < 5000, 'debe terminar mucho antes del timeout');
  });

  test('al abortar mueren también los nietos (árbol de procesos completo)', async () => {
    const controller = new AbortController();
    // El hijo (node) lanza un nieto (sleep 30) y se queda esperando; imprime el pid del nieto.
    const script = 'const c=require("child_process").spawn("sleep",["30"]); process.stdout.write(String(c.pid)); setTimeout(()=>{},60000)';
    setTimeout(() => controller.abort(), 300);
    const r = await run(node, ['-e', script], { signal: controller.signal });
    assert.equal(r.aborted, true);
    const grandchild = Number(r.stdout);
    assert.ok(grandchild > 0);
    await new Promise(res => setTimeout(res, 300));
    let alive = true;
    try { process.kill(grandchild, 0); } catch { alive = false; }
    assert.equal(alive, false, `el nieto ${grandchild} debería haber muerto`);
  });

  test('una señal ya abortada no lanza el proceso', async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await run(node, ['-e', 'process.stdout.write("no")'], { signal: controller.signal });
    assert.equal(r.aborted, true);
    assert.equal(r.stdout, '');
  });

  test('el timeout mata el proceso y marca timedOut', async () => {
    const r = await run(node, ['-e', 'setTimeout(() => {}, 60_000)'], { timeoutMs: 150 });
    assert.equal(r.timedOut, true);
    assert.equal(r.aborted, false);
  });

  test('un comando inexistente lanza CommandNotFoundError', async () => {
    await assert.rejects(run('comando-que-no-existe-xyz', []), CommandNotFoundError);
    assert.deepEqual(await commandExists('comando-que-no-existe-xyz'), { ok: false });
  });

  test('stdin recibe el input completo', async () => {
    const r = await run(node, ['-e', 'let d=""; process.stdin.on("data", c => d += c).on("end", () => process.stdout.write(String(d.length)))'], { input: 'x'.repeat(100_000) });
    assert.equal(r.stdout, '100000');
  });
});
