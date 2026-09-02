#!/usr/bin/env python3
"""
Runner no interactivo para Open Interpreter (paquete Python `open-interpreter`, 0.4.x).

Lo ejecuta el adaptador `src/adapters/interpreter.ts`; no está pensado para
usarse a mano, aunque se puede:

    echo "Ejecuta los tests" | python interpreter_runner.py --model gemini/gemini-2.5-flash
    python interpreter_runner.py --check          # ¿está instalado? → JSON con la versión

Entrada:  el prompt completo por stdin (multilínea, sin límite).
Salida:   una única línea JSON por stdout al terminar:
            {"messages": [{"role", "type", "format", "content"}, ...]}
          o {"error": "..."} con código de salida 2.
          Por stderr va el PROGRESO en vivo (texto del modelo, código ejecutado
          y salida de consola según se producen) más lo que Open Interpreter
          imprima por su cuenta, de modo que stdout sea JSON limpio.

¿Por qué no el CLI `interpreter --stdin`? Porque lee UNA sola línea (`input()`),
lo que trunca cualquier prompt multilínea.
"""
import argparse
import contextlib
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="solo comprobar que el paquete está instalado")
    parser.add_argument("--model", help="modelo en formato LiteLLM (gemini/…, openai/…, ollama/…)")
    parser.add_argument("--api-base", help="URL base para servidores OpenAI-compatibles")
    parser.add_argument("--api-key", help="clave del proveedor")
    parser.add_argument("--context-window", type=int, help="tamaño de contexto (evita el aviso para modelos desconocidos)")
    parser.add_argument("--max-tokens", type=int, help="máximo de tokens por respuesta")
    args = parser.parse_args()

    # Todo lo que el paquete imprima (banners, avisos de contexto…) va a stderr.
    real_stdout = sys.stdout
    with contextlib.redirect_stdout(sys.stderr):
        try:
            from interpreter import interpreter
        except ImportError as err:
            emit(real_stdout, {"error": f"open-interpreter no está instalado en {sys.executable}: {err}"})
            return 2

        version = package_version()
        if args.check:
            emit(real_stdout, {"version": version, "python": sys.executable})
            return 0

        prompt = sys.stdin.read().strip()
        if not prompt:
            emit(real_stdout, {"error": "prompt vacío por stdin"})
            return 2

        # Modo desatendido: ejecuta el código sin pedir confirmación, sin
        # telemetría, sin guardar historial y sin preguntas interactivas de
        # respaldo (con offline=True los errores del proveedor se propagan en
        # vez de abrir un `input()` que dejaría el proceso colgado).
        interpreter.auto_run = True
        interpreter.offline = True
        interpreter.disable_telemetry = True
        interpreter.conversation_history = False
        interpreter.plain_text_display = True

        if args.model:
            interpreter.llm.model = args.model
        if args.api_base:
            interpreter.llm.api_base = args.api_base
        if args.api_key:
            interpreter.llm.api_key = args.api_key
        if args.context_window:
            interpreter.llm.context_window = args.context_window
        if args.max_tokens:
            interpreter.llm.max_tokens = args.max_tokens

        try:
            messages = stream_chat(interpreter, prompt, progress=sys.stderr)
        except Exception as err:  # noqa: BLE001 — cualquier fallo se reporta como JSON
            emit(real_stdout, {"error": f"{type(err).__name__}: {err}", "version": version})
            return 2

    emit(real_stdout, {
        "version": version,
        "messages": [
            {
                "role": m.get("role"),
                "type": m.get("type"),
                "format": m.get("format"),
                "content": m.get("content") if isinstance(m.get("content"), str) else json.dumps(m.get("content")),
            }
            for m in messages
            if isinstance(m, dict) and m.get("format") != "active_line"
        ],
    })
    return 0


def stream_chat(interpreter, prompt: str, progress) -> list:
    """
    Ejecuta `interpreter.chat()` en modo streaming y va escribiendo el progreso
    en `progress` (stderr): así el proceso padre puede mostrar en vivo qué
    código se ejecuta y qué imprime, en vez de esperar al final.

    Los fragmentos llegan como {"role", "type", "format", "content"} con
    `start`/`end` en los límites de cada bloque. Devuelve los mensajes nuevos
    completos (igual que `chat(stream=False)`).
    """
    before = len(interpreter.messages)
    current_type = None
    for chunk in interpreter.chat(prompt, display=False, stream=True):
        if not isinstance(chunk, dict):
            continue
        ctype, cformat = chunk.get("type"), chunk.get("format")
        if cformat == "active_line":
            continue
        if chunk.get("start"):
            label = {"code": f"\n$ [{cformat or 'code'}]\n", "console": "\n> salida:\n", "message": "\n"}.get(ctype, "")
            if ctype != current_type or ctype != "message":
                progress.write(label)
            current_type = ctype
            continue
        if chunk.get("end"):
            progress.write("\n")
            progress.flush()
            continue
        content = chunk.get("content")
        if isinstance(content, str) and content:
            progress.write(content)
            progress.flush()
    return interpreter.messages[before + 1:]  # +1: el propio prompt del usuario


def package_version() -> str:
    try:
        from importlib.metadata import version
        return version("open-interpreter")
    except Exception:  # noqa: BLE001
        return "desconocida"


def emit(stream, payload: dict) -> None:
    stream.write(json.dumps(payload, ensure_ascii=False) + "\n")
    stream.flush()


if __name__ == "__main__":
    sys.exit(main())
