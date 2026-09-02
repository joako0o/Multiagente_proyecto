#!/usr/bin/env python3
"""
Antigravity Bridge — servidor HTTP compatible con la API de OpenAI.

Sirve para dos cosas:
  1. Exponer Gemini detrás de `/v1/chat/completions`, de modo que cualquier
     herramienta que solo hable "OpenAI" (Aider, Open Interpreter, el propio
     bridge con ANTIGRAVITY_PROVIDER=openai) pueda usarlo.
  2. Modo MOCK sin API key: devuelve respuestas de arquitecto plausibles para
     probar la tubería completa sin gastar cuota.

Uso:
    GEMINI_API_KEY=... python src/scripts/antigravity_bridge.py
    # o sin clave para el modo mock
    python src/scripts/antigravity_bridge.py

Variables:
    BRIDGE_PORT     puerto de escucha (por defecto 11435)
    GEMINI_API_KEY  si está definida, se reenvían las peticiones a Gemini
    GEMINI_MODEL    modelo de Gemini (por defecto gemini-2.5-flash)

Sin dependencias externas: solo biblioteca estándar.
"""

import json
import os
import re
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

PORT = int(os.environ.get("BRIDGE_PORT", "11435"))
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


# ---------------------------------------------------------------------------
# Backends
# ---------------------------------------------------------------------------

def call_gemini(messages: list) -> str:
    """Traduce mensajes estilo OpenAI a una petición de Gemini y devuelve el texto."""
    system_parts = [m["content"] for m in messages if m.get("role") == "system"]
    contents = [
        {"role": "model" if m.get("role") == "assistant" else "user", "parts": [{"text": m.get("content", "")}]}
        for m in messages
        if m.get("role") in ("user", "assistant")
    ]
    body = {"contents": contents, "generationConfig": {"temperature": 0.3, "maxOutputTokens": 6000}}
    if system_parts:
        body["system_instruction"] = {"parts": [{"text": "\n\n".join(system_parts)}]}

    request = urllib.request.Request(
        GEMINI_URL.format(model=GEMINI_MODEL),
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        data = json.loads(response.read().decode("utf-8"))

    parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
    return "\n".join(p.get("text", "") for p in parts if p.get("text") and not p.get("thought")).strip()


def mock_reply(messages: list) -> str:
    """Respuesta simulada de arquitecto. Distingue planificación de revisión por el contenido."""
    last = messages[-1].get("content", "") if messages else ""
    lowered = last.lower()

    if "turno de **revisión**" in lowered or "veredicto" in lowered:
        return (
            "### Revisión\n\n"
            "He revisado lo entregado por el equipo. La estructura es coherente con el plan y "
            "las verificaciones reportadas no muestran errores.\n\n"
            "VEREDICTO: APROBADO"
        )

    # Si el prompt trae una biblioteca de skills, asigna las dos primeras que aparezcan
    # (imita a un arquitecto real que elige del catálogo).
    skills_line = ""
    catalog = re.findall(r"^- `([a-z0-9-]+)` \(", last, flags=re.MULTILINE)
    if catalog:
        first, second = catalog[0], (catalog[1] if len(catalog) > 1 else catalog[0])
        skills_line = f"[SKILLS: opencode={first}; interpreter={second}]\n"

    return (
        "[EQUIPO: opencode, interpreter]\n"
        + skills_line
        + "\n### Plan de trabajo\n\n"
        "1. **Arquitectura:** módulo único con una función pública y un test que la ejercite.\n"
        "2. **OpenCode:** implementar el módulo y el test; documentar cómo ejecutarlo.\n"
        "3. **Open Interpreter:** ejecutar el test y reportar la salida real.\n\n"
        "Criterio de aceptación: el test pasa y el comando de ejecución está documentado.\n\n"
        "```bash\nnpm test\n```"
    )


# ---------------------------------------------------------------------------
# Servidor HTTP
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # noqa: N802 — firma de la clase base
        print(f"[bridge] {fmt % args}")

    def _json(self, status: int, payload: dict) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        path = urlparse(self.path).path
        if path in ("/health", "/v1/health"):
            self._json(200, {"status": "ok", "mode": "gemini" if GEMINI_API_KEY else "mock", "model": GEMINI_MODEL})
        elif path == "/v1/models":
            self._json(200, {"object": "list", "data": [{"id": GEMINI_MODEL, "object": "model", "owned_by": "bridge"}]})
        else:
            self._json(404, {"error": {"message": "ruta no encontrada"}})

    def do_POST(self):  # noqa: N802
        path = urlparse(self.path).path
        if path != "/v1/chat/completions":
            self._json(404, {"error": {"message": "ruta no encontrada"}})
            return

        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            messages = body.get("messages") or []
            text = call_gemini(messages) if GEMINI_API_KEY else mock_reply(messages)
        except urllib.error.HTTPError as err:
            self._json(err.code, {"error": {"message": f"Gemini HTTP {err.code}: {err.read()[:200].decode('utf-8', 'ignore')}"}})
            return
        except Exception as err:  # noqa: BLE001 — cualquier fallo se reporta al cliente
            self._json(500, {"error": {"message": str(err)}})
            return

        self._json(200, {
            "id": "chatcmpl-bridge",
            "object": "chat.completion",
            "model": body.get("model") or GEMINI_MODEL,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        })


def main() -> None:
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    mode = f"gemini ({GEMINI_MODEL})" if GEMINI_API_KEY else "mock (sin GEMINI_API_KEY)"
    print(f"[bridge] escuchando en http://127.0.0.1:{PORT}/v1 · modo: {mode}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[bridge] detenido")


if __name__ == "__main__":
    main()
