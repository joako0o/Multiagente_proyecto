# Sondas manuales de adaptadores

Scripts para probar cada adaptador **contra la herramienta real** (o un doble
fiel) sin pasar por el servidor ni gastar cuota de LLM. No forman parte de
`npm test`; se ejecutan a mano cuando se toca un adaptador o cambia la versión
de una herramienta.

| Script | Qué prueba | Requiere |
|---|---|---|
| `fake-llm.py` | Servidor OpenAI‑compatible en `:11500` que responde con una corrección fija (Aider/OpenCode) o con un bloque de shell + resumen (Open Interpreter). Soporta streaming SSE. Con `FAKE_LLM_SLOW=1` el comando de Open Interpreter dura 60 s e imprime progreso: sirve para probar "Detener turno" y la salida en vivo. | Python 3 |
| `opencode-abort.ts` | Que detener un turno cancela la petición a OpenCode y aborta la sesión en su servidor. | `opencode serve` |
| `aider.ts` | `AiderAdapter` con el CLI real: aplica la edición, limpia la salida, resume git, no ensucia el repo. | `pip install aider-chat` + `fake-llm.py` |
| `interpreter.ts` | `InterpreterAdapter` con el paquete Python real vía `interpreter_runner.py`; también el modo fallback si se apunta a un Python sin el paquete. | `pip install open-interpreter` + `fake-llm.py` |
| `opencode.ts` | `OpenCodeAdapter` contra `opencode serve` real (sesión, `?directory=`, partes). | binario `opencode` + proveedor configurado |
| `opencode-autostart.ts` | Que el adaptador levante `opencode serve` cuando no hay servidor. | `opencode` en el PATH |
| `openhands.ts` | `OpenHandsAdapter` en tres escenarios (settings guardados / por entorno / mal configurado). | CLI real o `fake-openhands.py` |
| `fake-openhands.py` | Doble del CLI `openhands --headless --json` que reproduce sus salidas reales (JSONL con esquema del SDK, mensajes de error de settings). | Python 3 |
| `skills-prompt.ts` | Imprime lo que ve el arquitecto (catálogo) y el dossier de skills de un agente nativo y de uno no nativo, con la biblioteca real. | biblioteca sincronizada |

## Receta completa sin credenciales

```bash
# 1. LLM falso
python scripts/probe/fake-llm.py &

# 2. Workspace de prueba: repo git con un bug que el LLM falso "sabe" corregir
mkdir -p /tmp/ws && cd /tmp/ws && git init -q
printf 'def suma(a, b):\n    return a - b\n' > calc.py
printf '{ "scripts": { "test": "node --test" } }' > package.json
cat > calc.test.js <<'EOF'
const { test } = require('node:test'); const assert = require('node:assert');
const { execSync } = require('node:child_process');
test('suma', () => assert.equal(execSync('python3 -c "from calc import suma; print(suma(2,3))"').toString().trim(), '5'));
EOF
git add -A && git commit -qm init

# 3. Proveedor falso para OpenCode (solo si se prueba OpenCode)
cat > opencode.json <<'EOF'
{ "provider": { "fakellm": { "npm": "@ai-sdk/openai-compatible",
  "options": { "baseURL": "http://127.0.0.1:11500/v1", "apiKey": "fake" },
  "models": { "fake": {} } } } }
EOF
opencode serve --port 4096 &

# 4. Doble de OpenHands como ejecutable
printf '#!/bin/sh\nexec python3 %s "$@"\n' "$PWD/scripts/probe/fake-openhands.py" > /tmp/openhands && chmod +x /tmp/openhands

# 5. Ciclo completo por el servidor con los cinco agentes
cd /tmp/ws
E2E_AGENTS=antigravity,opencode,openhands,aider,interpreter E2E_MAX_TURNS=8 \
ANTIGRAVITY_PROVIDER=openai ANTIGRAVITY_BASE_URL=http://127.0.0.1:11435/v1 \
OPENCODE_PROVIDER=fakellm OPENCODE_MODEL=fake \
OPENHANDS_COMMAND=/tmp/openhands OPENHANDS_MODEL=x OPENHANDS_API_KEY=x \
AIDER_MODEL=openai/fake AIDER_API_KEY=openai=fake AIDER_BASE_URL=http://127.0.0.1:11500/v1 \
INTERPRETER_MODEL=openai/fake INTERPRETER_API_BASE=http://127.0.0.1:11500/v1 INTERPRETER_API_KEY=fake \
node /ruta/al/bridge/scripts/test-e2e.js
```

(El arquitecto usa `src/scripts/antigravity_bridge.py` en modo mock, puerto 11435.)

## Versiones con las que se verificó

| Herramienta | Versión | Cómo |
|---|---|---|
| Aider | 0.86.2 | CLI real ejecutado; edición aplicada en un repo |
| Open Interpreter (Python) | 0.4.3 | paquete real ejecutado vía `interpreter_runner.py`; código ejecutado |
| Open Interpreter (binario Rust) | — | solo documentación oficial (`interpreter exec`), no ejecutado |
| OpenCode | 1.18.26 | servidor real; OpenAPI (`/doc`) contrastado con el adaptador; auto‑arranque probado |
| OpenHands | 1.16.0 | flags y esquema JSONL contrastados con el código fuente del wheel; ejecución con `fake-openhands.py` (el CLI real exige Python 3.12) |
