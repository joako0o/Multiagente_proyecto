#!/usr/bin/env python3
"""
LLM falso compatible con OpenAI para probar los adaptadores de CLI
(Aider, Open Interpreter) sin gastar cuota ni depender de internet.

    python scripts/probe/fake-llm.py          # escucha en http://127.0.0.1:11500/v1

- Soporta `stream: true` (SSE), porque Open Interpreter siempre lo usa.
- Escenario Aider: devuelve un archivo completo corregido (edit format "whole").
- Escenario Open Interpreter: la primera llamada devuelve un bloque de shell
  para que OI lo ejecute; la siguiente devuelve el resumen final.

Solo biblioteca estándar.
"""
import json
import re
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 11500

AIDER_REPLY = """Corrijo el bug de la resta: la función devolvía a - b.

calc.py
```python
def suma(a, b):
    return a + b
```
"""

OI_CODE_REPLY = """Voy a verificar el proyecto ejecutando las pruebas.

```shell
echo "== pruebas ==" && npm test
```
"""

OI_FINAL_REPLY = "Las pruebas se ejecutaron correctamente: 1 test, 0 fallos. El proyecto está en buen estado."


def pick_reply(body: dict) -> str:
    messages = body.get("messages", [])
    system = " ".join(
        m.get("content", "") for m in messages
        if m.get("role") == "system" and isinstance(m.get("content"), str)
    )
    if "Open Interpreter" in system:
        has_output = any(
            m.get("role") != "system" and isinstance(m.get("content"), str)
            and ("== pruebas ==" in m["content"] or "Output" in m["content"])
            for m in messages
        )
        return OI_FINAL_REPLY if has_output else OI_CODE_REPLY
    return AIDER_REPLY


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # noqa: N802 — silenciar log por defecto
        pass

    def _send_json(self, payload: dict, status: int = 200) -> None:
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):  # noqa: N802
        self._send_json({"object": "list", "data": [{"id": "fake", "object": "model"}]})

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        text = pick_reply(body)
        print(f"[fake-llm] stream={body.get('stream')} msgs={len(body.get('messages', []))} -> {text[:40]!r}", flush=True)

        if body.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            # Se emite palabra a palabra (como un LLM real); nunca se parte un "```lenguaje".
            for piece in re.findall(r"\S+|\s+", text):
                chunk = {"id": "x", "object": "chat.completion.chunk", "model": "fake",
                         "choices": [{"index": 0, "delta": {"content": piece}, "finish_reason": None}]}
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            done = {"id": "x", "object": "chat.completion.chunk", "model": "fake",
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
            self.wfile.write(f"data: {json.dumps(done)}\n\ndata: [DONE]\n\n".encode())
            self.wfile.flush()
            return

        self._send_json({
            "id": "x", "object": "chat.completion", "model": "fake",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        })


if __name__ == "__main__":
    print(f"[fake-llm] escuchando en http://127.0.0.1:{PORT}/v1")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
