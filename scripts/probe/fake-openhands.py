#!/usr/bin/env python3
"""
Doble de `openhands` para probar el adaptador sin instalar OpenHands
(requiere Python 3.12 exacto y ~1 GB de dependencias).

Reproduce lo que hace el CLI real 1.16 en modo `--headless --json`, según su
código fuente (openhands_cli/entrypoint.py, textual_app.py, utils.json_callback):

  * `--version`                        → "openhands 1.16.0"
  * sin settings y sin --override-with-envs
                                       → "Headless mode requires existing settings." (exit 0)
  * --override-with-envs sin LLM_API_KEY/LLM_MODEL
                                       → "Error: Missing required environment variable(s)…" (exit 1)
  * caso normal                        → líneas de estado + eventos JSONL con el
                                         esquema del SDK (MessageEvent, ActionEvent,
                                         ObservationEvent, FinishAction) + resumen.

Uso desde el adaptador:  OPENHANDS_COMMAND="python3 scripts/probe/fake-openhands.py"
(no soportado: el adaptador espera un ejecutable) → crear un wrapper ejecutable:
    printf '#!/bin/sh\nexec python3 %s "$@"\n' "$PWD/scripts/probe/fake-openhands.py" > /tmp/openhands && chmod +x /tmp/openhands
    OPENHANDS_COMMAND=/tmp/openhands
"""
import json
import os
import sys
from pathlib import Path


def event(**kwargs) -> None:
    print(json.dumps(kwargs), flush=True)


def main() -> int:
    args = sys.argv[1:]
    if "--version" in args or "-v" in args:
        print("openhands 1.16.0")
        return 0

    if "--headless" not in args:
        print("(fake) solo se soporta --headless", file=sys.stderr)
        return 2

    has_settings = Path(os.environ.get("FAKE_OPENHANDS_SETTINGS", "/nonexistent")).exists()
    override = "--override-with-envs" in args

    if not has_settings and not override:
        print("Headless mode requires existing settings.")
        print("Please run: openhands to configure your settings before using --headless.")
        return 0

    if override and (not os.environ.get("LLM_API_KEY") or not os.environ.get("LLM_MODEL")):
        missing = [k for k in ("LLM_API_KEY", "LLM_MODEL") if not os.environ.get(k)]
        print(f"Error: Missing required environment variable(s): {', '.join(missing)}")
        return 1

    task = ""
    if "-f" in args:
        task = Path(args[args.index("-f") + 1]).read_text(encoding="utf-8")
    elif "-t" in args:
        task = args[args.index("-t") + 1]

    print("Initializing agent...")
    event(kind="MessageEvent", id="e1", timestamp="t", source="user",
          llm_message={"role": "user", "content": [{"type": "text", "text": task[:80]}]})
    event(kind="ActionEvent", id="e2", timestamp="t", source="agent", tool_name="terminal", tool_call_id="c1",
          action={"kind": "TerminalAction", "command": "npm test", "is_input": False, "timeout": None})
    event(kind="ObservationEvent", id="e3", timestamp="t", source="environment", tool_name="terminal", tool_call_id="c1",
          action_id="e2", observation={"kind": "TerminalObservation", "content": [{"type": "text", "text": "1 passing"}],
                                       "is_error": False, "command": "npm test", "exit_code": 0, "timeout": False})
    event(kind="ActionEvent", id="e4", timestamp="t", source="agent", tool_name="file_editor", tool_call_id="c2",
          action={"kind": "FileEditorAction", "command": "str_replace", "path": os.path.join(os.getcwd(), "calc.py"),
                  "old_str": "a - b", "new_str": "a + b"})
    event(kind="ObservationEvent", id="e5", timestamp="t", source="environment", tool_name="file_editor", tool_call_id="c2",
          action_id="e4", observation={"kind": "FileEditorObservation", "content": [], "is_error": False, "command": "str_replace"})
    event(kind="ActionEvent", id="e6", timestamp="t", source="agent", tool_name="finish", tool_call_id="c3",
          action={"kind": "FinishAction", "message": f"Tarea completada usando {os.environ.get('LLM_MODEL', 'settings guardados')}: corregí calc.py y los tests pasan."})
    print("Agent finished")
    print("──── CONVERSATION SUMMARY ────")
    print("Goodbye! 👋")
    print("Conversation ID: deadbeef")
    return 0


if __name__ == "__main__":
    sys.exit(main())
