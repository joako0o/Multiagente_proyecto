# ⚡ Antigravity ↔ OpenCode Multi-Agent Bridge 2.0

Puente de colaboración **multi-agente** que orquesta, por turnos y fases, a cuatro agentes de IA/herramientas para planificar, implementar, ejecutar y versionar un proyecto de software. Incluye servidor Express + WebSocket y un panel web en tiempo real con renderizado Markdown.

```
Usuario ──► Panel Web (WebSocket) ──► ConversationManager (loop por turnos)
                                              │
        ┌─────────────┬───────────────┬───────┴──────────┬───────────────┐
        ▼             ▼               ▼                  ▼               ▼
  🏛️ Antigravity   💻 OpenCode    ⚡ Open Interpreter   🐙 Aider     📝 conversations/*.md
  (Gemini API)    (server :4096)  (terminal local)    (git CLI)     (historial persistido)
```

## Agentes

| ID | Nombre | Rol | Backend real |
|----|--------|-----|--------------|
| `antigravity` | Google Antigravity | **Arquitecto / Líder Técnico** — planifica en el turno 0 y **revisa** en los siguientes. Emite el veredicto `APROBADO` / `REQUIERE_CAMBIOS`. | Gemini API (`generativelanguage.googleapis.com`) con `GEMINI_API_KEY` |
| `opencode` | OpenCode Desktop | **Desarrollador** — implementa el código a partir del plan. | Servidor local de OpenCode (`opencode serve --port 4096`, API `/session`) |
| `interpreter` | Open Interpreter | **Ejecutor / QA** — corre comandos de validación en el workspace. | `child_process.exec` local (npm/node/python/powershell) |
| `aider` | Aider Git Master | **Control de versiones** — reporta rama y `git status` del workspace. | `git` CLI local |

## Flujo de una sesión

1. Se crea una conversación con título, workspace, modo de orquestación (`autonomous` o `manual`), agentes y máximo de turnos.
2. `start_loop` añade el prompt del usuario y arranca el ciclo. En cada turno se elige el agente por *round-robin* (`turno % agentes.length`).
3. La **fase** se actualiza según el agente activo: `PLANNING` (turno 0) → `DEVELOPMENT` (OpenCode/Aider) → `EXECUTION` (Interpreter) → `REVIEW` (Antigravity) → `COMPLETED`.
4. En **modo autónomo**, Antigravity puede definir el equipo en el turno 0 con la etiqueta `[EQUIPO: antigravity, opencode, interpreter, aider]`.
5. El ciclo termina cuando Antigravity, en fase `REVIEW`, responde con `APROBADO`/`FINALIZADO`/`GOAL_REACHED`/`OBJETIVO CUMPLIDO` (y sin marcas de trabajo pendiente), o al llegar a `maxTurns`.
6. Cada mensaje se persiste en `conversations/<workspace>/<fecha>_<título>.md`.

## Requisitos

- **Node.js ≥ 18** (usa `fetch` y `AbortSignal.timeout` nativos).
- Una **API key de Gemini** (Google AI Studio) para Antigravity.
- Opcional: **OpenCode** instalado y accesible (`opencode serve --port 4096`), **git** y **Python 3** en el PATH.

## Instalación y uso

```bash
npm install
cp .env.example .env      # y completa GEMINI_API_KEY
npm run build             # compila TS → dist/ y copia web/ y scripts/
npm start                 # http://localhost:3000
```

Para desarrollo sin compilar:

```bash
npm run dev               # ts-node src/index.ts
```

### Scripts disponibles

| Script | Descripción |
|--------|-------------|
| `npm run build` | `tsc` + copia de `src/web` y `src/scripts` a `dist/` |
| `npm start` | Levanta el servidor desde `dist/` |
| `npm run dev` | Levanta el servidor con `ts-node` |
| `npm run typecheck` | Chequeo de tipos sin emitir |
| `npm run clean` | Borra `dist/` |
| `npm run test:e2e` | Prueba E2E por WebSocket (requiere `dist/` compilado y `GEMINI_API_KEY`) |
| `npm run bridge` | Inicia el *Antigravity Bridge* (servidor Python compatible con la API de OpenAI, puerto 11435) |

### Variables de entorno

Ver [`.env.example`](.env.example).

| Variable | Default | Uso |
|----------|---------|-----|
| `PORT` / `HOST` | `3000` / `localhost` | Servidor web + WebSocket |
| `GEMINI_API_KEY` | — | **Obligatoria** para Antigravity |
| `ANTIGRAVITY_MODEL` | `gemini-2.5-flash` | Modelo del arquitecto |
| `OPENCODE_URL` | `http://localhost:4096` | Servidor OpenCode |
| `OPENCODE_PASSWORD` / `OPENCODE_MODEL` | — / `gemini-2.5-flash` | Credencial y modelo de OpenCode |
| `BRIDGE_PORT` / `ANTIGRAVITY_APP_DIR` | `11435` / — | Antigravity Bridge (Python) |

## API

### REST

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/health` | Estado del servidor y nº de conversaciones |
| `GET` | `/api/agents` | Agentes registrados |
| `GET` | `/api/agents/status` | Disponibilidad real de cada backend |
| `GET` | `/api/conversations` | Resumen de conversaciones |
| `GET` | `/api/conversations/:id` | Conversación completa con mensajes |

### WebSocket (`/ws`)

Mensajes **cliente → servidor** (`{ type, data }`):

| `type` | `data` |
|--------|--------|
| `create_conversation` | `{ title, agentIds[], projectPath?, orchestrationMode?, maxTurns? }` |
| `start_loop` | `{ conversationId, initialPrompt, config?: { maxTurns, delayBetweenTurns, autoStopOnError, projectPath, orchestrationMode } }` |
| `send_message` | `{ conversationId, content, agentId?, metadata? }` |
| `pause_loop` / `resume_loop` | `{ conversationId }` |

Eventos **servidor → cliente**: `connected`, `conversation_created`, `message`, `turn_change`, `phase_change`, `status`, `error`.

## Estructura del proyecto

```
src/
├── index.ts                  # Entrada: carga .env y arranca el servidor
├── types/index.ts            # Tipos compartidos (Agent, Conversation, fases, eventos…)
├── core/conversation-manager.ts  # Loop por turnos, fases, contexto por rol, persistencia .md
├── server/
│   ├── index.ts              # Express: estáticos + API REST + registro de agentes
│   └── websocket-server.ts   # WS: comandos del cliente y broadcast de eventos
├── adapters/
│   ├── antigravity.ts        # Gemini API con reintentos (429/503)
│   ├── opencode.ts           # Cliente del servidor OpenCode (sesiones, auto-arranque en Windows)
│   ├── interpreter.ts        # Ejecución de comandos locales de validación
│   └── aider.ts              # Inspección de git status / rama
├── web/index.html            # Panel web (marked + highlight.js)
└── scripts/antigravity_bridge.py  # Servidor Python OpenAI-compatible (SDK o modo mock)
scripts/
├── copy-assets.js            # Copia web/ y scripts/ a dist/ tras compilar
└── test-e2e.js               # Prueba end-to-end vía WebSocket
```

## Notas y limitaciones conocidas

- **Dependencias de Windows:** `OpenCodeAdapter` intenta auto-arrancar OpenCode con `cmd.exe /c opencode.cmd serve`, e `InterpreterAdapter` usa `powershell` como comando por defecto. En Linux/macOS hay que levantar OpenCode manualmente y el Interpreter devolverá `powershell: not found` en el caso genérico (el resto de ramas `npm`/`node`/`python` sí funcionan).
- **Detección de veredicto por palabras clave:** el cierre del ciclo depende de que Antigravity incluya literalmente `APROBADO` (y no `INCOMPLETO`, `REQUIERE_CAMBIOS`, etc.). Si el modelo parafrasea, el ciclo sigue hasta `maxTurns`.
- **Estado en memoria:** las conversaciones viven en un `Map`; al reiniciar el servidor solo queda el historial en `conversations/*.md`.
- **`resume_loop`** relanza `runLoop` sin comprobar si ya hay un ciclo activo (a diferencia de `start_loop`), por lo que dos "Reanudar" seguidos podrían solapar turnos.
- **Reintentos:** Antigravity espera 10 s ante `429/503` (free tier de Gemini); OpenCode reintenta con *backoff* y recrea la sesión si recibe `404`.
