# ⚡ Multi-Agent Bridge

Orquestador **multi-agente por turnos** para desarrollo de software. Un agente arquitecto (LLM) planifica y revisa; agentes especializados —herramientas open source reales— implementan, ejecutan pruebas y gestionan Git sobre **un proyecto de tu disco**. Todo se sigue en un panel web en tiempo real y queda guardado en Markdown.

```
                    ┌────────────────────────────────────────────────┐
  Usuario ──────►   │  Panel web  ◄──WebSocket──►  Orquestador       │
  "Crea una API"    │                               (turnos/fases)   │
                    └───────┬────────┬─────────┬─────────┬───────────┘
                            ▼        ▼         ▼         ▼         ▼
                       🏛️ Anti-  💻 Open-  🤖 Open-  🐙 Aider  ⚡ Open
                       gravity   Code      Hands               Interpreter
                       (LLM)     (HTTP)    (CLI)     (CLI)     (CLI)
                                     └─────── tu proyecto ────────┘
```

## Los agentes

| | Agente | Rol en el equipo | Cómo se integra | Instalación |
|---|---|---|---|---|
| 🏛️ | **Antigravity** | Arquitecto y revisor. Abre cada sesión con un plan, reparte tareas y cierra con `VEREDICTO: APROBADO` o `REQUIERE_CAMBIOS`. | API de Gemini, o cualquier endpoint OpenAI‑compatible (Ollama, LM Studio, bridge incluido). | Solo una API key |
| 💻 | **OpenCode** | Desarrollador principal. | Servidor HTTP local (`opencode serve`). | [opencode.ai](https://opencode.ai) |
| 🤖 | **OpenHands** | Ingeniero autónomo de punta a punta (explora, edita, ejecuta, corrige). | CLI headless con salida JSONL. | `uv tool install openhands --python 3.12` |
| 🐙 | **Aider** | Editor quirúrgico orientado a Git. | CLI en modo `--message-file`. | `pip install aider-install && aider-install` |
| ⚡ | **Open Interpreter** | Ejecución y QA en el entorno real. | Paquete Python vía `interpreter_runner.py` (o el binario nuevo con `interpreter exec`). **Si no está instalado, funciona en modo limitado**: ejecuta los comandos de test/build que el equipo proponga. | `pip install open-interpreter` |

Solo Antigravity es obligatorio. El resto se detecta al arrancar; el panel muestra qué agentes están disponibles y por qué no lo están los demás.

Las integraciones están verificadas contra versiones reales (Aider 0.86.2, Open Interpreter 0.4.3, OpenCode 1.18.26, OpenHands 1.16.0); el detalle está en [`scripts/probe/README.md`](scripts/probe/README.md), junto con una receta para probar el ciclo completo sin credenciales.

## Inicio rápido

```bash
npm install
cp .env.example .env        # pon tu GEMINI_API_KEY
npm run build
npm start                   # → http://localhost:3000
```

Sin API key puedes probar toda la tubería con el bridge en modo mock:

```bash
python src/scripts/antigravity_bridge.py              # terminal 1 (puerto 11435)
ANTIGRAVITY_PROVIDER=openai npm start                  # terminal 2
```

### Cómo se usa

1. **Nueva sesión** → título, directorio del proyecto, modo y máximo de turnos.
2. Escribe el **objetivo** y envíalo. (Atajo: escribir sin sesión crea una autónoma.)
3. Observa los turnos: el panel muestra fase, agente activo y cada respuesta renderizada.
4. **Pausar** detiene el ciclo tras el turno en curso; **Reanudar** lo continúa.
5. El historial queda en `conversations/<proyecto>/<fecha>_<título>.md`.

### Modos de orquestación

- **Autónomo** — Antigravity elige el equipo en el primer turno con la etiqueta `[EQUIPO: opencode, interpreter]`.
- **Manual** — tú marcas qué agentes participan. El arquitecto siempre está.

## Cómo funciona un ciclo

```
turno 0   🏛️ Antigravity   PLANNING     plan + reparto de tareas (+ equipo si es autónomo)
turno 1   💻 OpenCode      DEVELOPMENT  implementa
turno 2   ⚡ Interpreter   EXECUTION    ejecuta las pruebas propuestas
turno 3   🏛️ Antigravity   REVIEW       VEREDICTO: REQUIERE_CAMBIOS → sigue / APROBADO → fin
turno 4   💻 OpenCode      DEVELOPMENT  corrige…
```

Los agentes se turnan en round‑robin en el orden del equipo. Cada uno recibe un prompt con: contexto de la sesión, instrucciones de su rol, el objetivo original y los últimos mensajes. El ciclo termina con la aprobación del arquitecto o al agotar los turnos.

## Configuración

Todas las variables están comentadas en [`.env.example`](.env.example). Las importantes:

| Variable | Default | Para qué |
|---|---|---|
| `GEMINI_API_KEY` | — | Arquitecto (y por defecto OpenHands/Aider) |
| `ANTIGRAVITY_PROVIDER` | `gemini` | `gemini` o `openai` (endpoint compatible) |
| `ANTIGRAVITY_MODEL` | `gemini-2.5-flash` | Modelo del arquitecto |
| `OPENCODE_URL` | `http://127.0.0.1:4096` | Servidor OpenCode; se auto‑arranca si `OPENCODE_AUTO_START=true` |
| `OPENHANDS_MODEL` / `AIDER_MODEL` / `INTERPRETER_MODEL` | `gemini/gemini-2.5-flash` si hay key | Modelo en formato LiteLLM |
| `INTERPRETER_PYTHON` | `python3` | Python donde está instalado `open-interpreter` (p. ej. un venv) |
| `AIDER_AUTO_COMMITS` | `false` | Si Aider hace commit automático |
| `LOOP_MAX_TURNS` / `LOOP_DELAY_MS` | `15` / `3000` | Ciclo por defecto |

## Scripts

| Comando | Qué hace |
|---|---|
| `npm run dev` | Arranca desde `src/` con ts-node (sin compilar) |
| `npm run build` | Compila a `dist/` y copia el panel |
| `npm start` | Arranca desde `dist/` |
| `npm test` | Pruebas unitarias e integración (sin red ni herramientas externas) |
| `npm run typecheck` | Chequeo estricto de tipos (src + tests) |
| `npm run test:e2e` | Ciclo real por WebSocket contra el servidor compilado |
| `npm run bridge` | Servidor Python OpenAI‑compatible (Gemini o mock) |
| `scripts/probe/*` | Sondas manuales de cada adaptador contra la herramienta real ([guía](scripts/probe/README.md)) |

## API

**REST** (solo lectura): `GET /api/health`, `/api/agents`, `/api/agents/status`, `/api/conversations`, `/api/conversations/:id`, `/api/phases`.

**WebSocket** `/ws` — comandos del cliente: `create_conversation`, `start_loop`, `send_message`, `pause_loop`, `resume_loop`. Eventos del servidor: `connected`, `conversation_created`, `message`, `turn_change`, `phase_change`, `status`, `error`. Tipos exactos en [`src/types/index.ts`](src/types/index.ts).

## Estructura del código

```
src/
├── index.ts               Punto de entrada
├── config.ts              Lee .env → AppConfig tipado (único sitio con process.env)
├── types/index.ts         Contratos compartidos (Agent, Conversation, eventos WS…)
├── agents/
│   ├── catalog.ts         Nombre, rol y emoji de cada agente (fuente única)
│   └── registry.ts        Une catálogo + adaptadores. ← Cómo añadir un agente
├── adapters/              Una integración por herramienta
│   ├── base-cli-adapter.ts  Base para los que envuelven una CLI
│   ├── antigravity.ts     Gemini / OpenAI-compatible
│   ├── opencode.ts        HTTP sessions API
│   ├── openhands.ts       CLI headless + parser JSONL
│   ├── aider.ts           CLI --message-file + resumen git
│   └── interpreter.ts     CLI exec + modo fallback
├── core/
│   ├── orchestrator.ts    Ciclo de turnos, estado, eventos
│   ├── prompt-builder.ts  Prompt por rol y fase
│   ├── phases.ts          Regla turno/agente → fase
│   ├── verdict.ts         Parseo de VEREDICTO y [EQUIPO]
│   └── history-writer.ts  Persistencia .md
├── server/
│   ├── index.ts           Express + composición de dependencias
│   ├── http-routes.ts     API REST
│   └── websocket-server.ts
├── utils/                 shell (procesos externos), paths
├── web/                   Panel: index.html, styles.css, app.js (sin framework)
└── scripts/
    ├── antigravity_bridge.py   Servidor OpenAI-compatible (Gemini o mock)
    └── interpreter_runner.py   Puente hacia el paquete Python de Open Interpreter
tests/                     node:test, 50 casos, sin dependencias externas
scripts/probe/             Sondas manuales contra herramientas reales + dobles (fake-llm, fake-openhands)
docs/ARCHITECTURE.md       Decisiones de diseño y guía para extender
```

Para entender las decisiones de diseño y cómo añadir un agente, lee [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Limitaciones conocidas

- **Estado en memoria.** Las sesiones no sobreviven a un reinicio del servidor; el historial `.md` sí.
- **Un servidor = un usuario.** No hay autenticación; está pensado para correr en tu máquina.
- **Los agentes modifican archivos de verdad.** Usa un workspace bajo Git y revisa los diffs. OpenHands en modo headless auto‑aprueba todas sus acciones.
- **Cuotas.** Con el free tier de Gemini, varios agentes compartiendo la misma key pueden dar `429`; el arquitecto reintenta con espera, el resto reporta el error y el ciclo continúa.
