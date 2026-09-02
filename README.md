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
4. Mientras un agente trabaja ves su **salida en vivo** (comandos que ejecuta, tests que corren). **Pausar** deja terminar el turno en curso y no inicia otro; **Detener turno** interrumpe al agente ahora mismo (mata su proceso o aborta su petición) y conserva la salida parcial; **Reanudar** continúa desde ahí.
5. La pestaña **Archivos del workspace** muestra lo que van produciendo los agentes (informes Markdown, gráficos SVG/PNG, páginas HTML con d3, CSV) sin salir del panel. **Eliminar sesión** la quita del panel; el `.md` se conserva.
6. El historial legible queda en `conversations/<proyecto>/<fecha>_<título>.md`; el estado de cada sesión en `conversations/.sessions/<id>.json`, y **sobrevive a reinicios**: si el servidor cae en mitad de un ciclo, la sesión vuelve en pausa y puedes reanudarla.

### Modos de orquestación

- **Autónomo** — Antigravity elige el equipo en el primer turno con la etiqueta `[EQUIPO: opencode, interpreter]`.
- **Manual** — tú marcas qué agentes participan. El arquitecto siempre está.

## Skills: equipar a cada agente

Una **skill** es una carpeta con un `SKILL.md` (instrucciones + descripción de cuándo usarla) y, opcionalmente, `scripts/`, `references/` y `assets/`. Es el estándar [Agent Skills](https://agentskills.io/specification), el mismo que usan Claude Code, OpenHands y OpenCode, así que puedes reutilizar directamente las que hay publicadas en GitHub.

```
 .env: SKILLS_SOURCES=anthropics/skills,microsoft/skills
                │
                ▼  git clone (al arrancar o con "Sincronizar")
   .skills-cache/                 skills/ (incluidas)           .skills-cache/local/ (tuyas)
        │                              │                              │
        └──────────────┬───────────────┴──────────────────────────────┘
                       ▼
             Biblioteca (catálogo: nombre + descripción)
                       │
   turno 0  ──────────►│  El arquitecto ve el catálogo y responde:
                       │  [SKILLS: opencode=visualizacion-d3; interpreter=econometria-series-temporales]
                       ▼
        <workspace>/.agents/skills/<name>/   ← copiadas antes del turno de cada agente
                       │
        ┌──────────────┴──────────────┐
        ▼                             ▼
  OpenHands / OpenCode          Aider / Open Interpreter / Antigravity
  las cargan solos de esa       reciben en el prompt: "tu rol es X, estas son tus
  carpeta (soporte nativo)      skills, aquí están sus instrucciones y archivos"
```

- **Tú también puedes asignarlas** en el formulario de nueva sesión (buscador por agente). El arquitecto puede ampliar tu asignación, nunca quitarla.
- **Con bibliotecas grandes** (cientos de skills) el arquitecto no ve el catálogo entero: un ranking léxico local (español↔inglés, sin LLM) le muestra las ~25 más relevantes para el objetivo, más las que tú fijaste. El mismo ranking alimenta el buscador del panel y `GET /api/skills?q=`.
- **Incluidas de serie** en [`skills/`](skills/): `econometria-series-temporales`, `api-financiera-cliente`, `visualizacion-d3`. Añade las tuyas creando otra carpeta ahí (o en `.skills-cache/local/` si no quieres versionarlas).
- **Licencias**: cada skill declara la suya en el frontmatter (el panel la muestra). Los repositorios por defecto son MIT, pero dentro de `anthropics/skills` y `scientific-agent-skills` hay algunas propietarias (`xlsx`, `pdf`, `docx`, `pptx` de Anthropic); revísalas antes de usarlas en algo que distribuyas.
- La carpeta `.agents/skills/` del workspace se añade a `.git/info/exclude` del proyecto, así que no aparece en tu `git status`.

### Qué hay disponible por área

Repositorios públicos con `SKILL.md` que puedes poner en `SKILLS_SOURCES` (estrellas y licencia a fecha de esta versión):

| Área | Repositorio | Qué aporta |
|---|---|---|
| **Documentos y presentaciones** | `anthropics/skills` · `bytedance/deer-flow` | Word/Excel/PowerPoint/PDF nativos, `ppt-generation`, `doc-coauthoring`, pósters y slides científicos (`scientific-agent-skills`) |
| **Datos y análisis** | `bytedance/deer-flow` · `K-Dense-AI/scientific-agent-skills` | `data-analysis` (CSV/Excel → estadísticas, pivots, SQL), `chart-visualization`, `statistical-analysis`, `statsmodels`, `exploratory-data-analysis`, `timesfm-forecasting`, `matplotlib`, `geopandas` |
| **Investigación** | `bytedance/deer-flow` · `K-Dense-AI/scientific-agent-skills` | `deep-research`, `systematic-literature-review`, `academic-paper-review`, `paper-lookup`, `citation-management`, `scientific-writing`, `peer-review`, `market-research-reports` |
| **Páginas web** | `anthropics/skills` · `vercel-labs/agent-skills` · `bytedance/deer-flow` | `frontend-design`, `web-artifacts-builder`, `webapp-testing`, React/Next.js, `web-design-guidelines` |
| **Diseño UI/UX** | `bergside/awesome-design-skills` (67 estilos) · `wshobson/agents` (`ui-design`, `accessibility-compliance`) | Sistemas de estilo (editorial, corporate, brutalism…), `theme-factory`, `brand-guidelines`, auditoría WCAG |
| **Gestión de proyectos / producto** | `addyosmani/agent-skills` · `obra/superpowers` | `planning-and-task-breakdown`, `spec-driven-development`, `idea-refine`, `writing-plans`, `brainstorming`, `documentation-and-adrs` |
| **Ingeniería** | `addyosmani/agent-skills` · `obra/superpowers` · `wshobson/agents` (183) | TDD, depuración sistemática, revisión de código, APIs, CI/CD, bases de datos, despliegue |
| **ML / IA** | `huggingface/skills` · `wshobson/agents` | Modelos, datasets, entrenamiento, Gradio, fine‑tuning |
| **Catálogos grandes** | `github/awesome-copilot` (400+) · `microsoft/skills` (198, Azure) · `nexu-io/open-design` (500+, plantillas de diseño) | Muy heterogéneos; útiles para buscar algo concreto, pesados para cargar enteros |

Los cuatro primeros (`anthropics/skills`, `bytedance/deer-flow`, `K-Dense-AI/scientific-agent-skills`, `addyosmani/agent-skills`) vienen configurados por defecto: cubren documentos, datos, investigación e ingeniería, que es el trabajo habitual de este proyecto. `scientific-agent-skills` ocupa ~500 MB por sus scripts; si te sobra, quítalo de `SKILLS_SOURCES`.

## Cómo funciona un ciclo

```
turno 0   🏛️ Antigravity   PLANNING     plan + reparto de tareas (+ equipo si es autónomo)
turno 1   💻 OpenCode      DEVELOPMENT  implementa
turno 2   ⚡ Interpreter   EXECUTION    ejecuta las pruebas propuestas
turno 3   🏛️ Antigravity   REVIEW       VEREDICTO: REQUIERE_CAMBIOS → sigue / APROBADO → fin
turno 4   💻 OpenCode      DEVELOPMENT  corrige…
```

Los agentes se turnan en round‑robin en el orden del equipo. Cada uno recibe un prompt con: contexto de la sesión, instrucciones de su rol, sus skills, el objetivo original y los últimos mensajes. El ciclo termina con la aprobación del arquitecto o al agotar los turnos.

En una revisión con `REQUIERE_CAMBIOS`, el arquitecto puede **pasar el turno directamente** a quien deba corregir con `[SIGUIENTE: aider]`; el round‑robin continúa desde ese agente. Sin la etiqueta, sigue el orden habitual.

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
| `SKILLS_SOURCES` | 4 repos (docs, datos, ciencia, ingeniería) | Repositorios de skills (`owner/repo[@ref]` o URL, separados por comas) |
| `SKILLS_CACHE_DIR` / `SKILLS_SYNC_ON_START` | `./.skills-cache` / `true` | Dónde se clonan y si se actualizan al arrancar |
| `HISTORY_DIR` / `SESSIONS_DIR` | `./conversations` / `./conversations/.sessions` | Historial `.md` y estado `.json` de las sesiones |

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

**REST**: `GET /api/health`, `/api/agents`, `/api/agents/status`, `/api/conversations`, `/api/conversations/:id`, `/api/conversations/:id/files?dir=` (listado del workspace), `/api/conversations/:id/files/raw?path=` (contenido, solo lectura y confinado al workspace), `/api/phases`, `/api/skills`, `/api/skills/:name`; `POST /api/skills/sync` (vuelve a clonar/actualizar los repositorios de skills).

**WebSocket** `/ws` — comandos del cliente: `create_conversation`, `start_loop`, `send_message`, `pause_loop`, `resume_loop`, `stop_turn`, `delete_conversation`. Eventos del servidor: `connected`, `conversation_created`, `conversation_deleted`, `message`, `turn_change`, `turn_output` (salida parcial del agente en curso), `phase_change`, `status`, `error`. Tipos exactos en [`src/types/index.ts`](src/types/index.ts).

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
│   ├── verdict.ts         Parseo de VEREDICTO, [EQUIPO] y [SIGUIENTE]
│   ├── history-writer.ts  Historial legible .md
│   ├── session-store.ts   Estado .json por sesión (recuperación tras reinicio)
│   └── workspace-files.ts Listado/lectura segura del workspace para el panel
├── skills/
│   ├── skill-file.ts      Parseo/validación de SKILL.md (estándar Agent Skills)
│   ├── skill-library.ts   Clona repos, indexa el catálogo, materializa en el workspace
│   ├── skill-briefing.ts  Catálogo para el arquitecto, parseo de [SKILLS], dossier por agente
│   ├── skill-search.ts    Ranking léxico es/en para preseleccionar skills relevantes
│   └── skill-coordinator.ts  Enlace con el orquestador (qué ve cada agente en su turno)
├── server/
│   ├── index.ts           Express + composición de dependencias
│   ├── http-routes.ts     API REST
│   └── websocket-server.ts
├── utils/                 shell (procesos externos), paths, git
├── web/                   Panel: index.html, styles.css, app.js (sin framework)
└── scripts/
    ├── antigravity_bridge.py   Servidor OpenAI-compatible (Gemini o mock)
    └── interpreter_runner.py   Puente hacia el paquete Python de Open Interpreter
skills/                    Skills incluidas (econometría, APIs financieras, d3.js)
tests/                     node:test, 109 casos, sin dependencias externas
scripts/probe/             Sondas manuales contra herramientas reales + dobles (fake-llm, fake-openhands)
docs/ARCHITECTURE.md       Decisiones de diseño y guía para extender
```

Para entender las decisiones de diseño y cómo añadir un agente, lee [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Limitaciones conocidas

- **Un servidor = un usuario.** No hay autenticación; está pensado para correr en tu máquina. El explorador de archivos expone (solo lectura) el workspace de cada sesión a quien pueda abrir el panel.
- **Un ciclo interrumpido no se retoma a mitad de turno.** Si el servidor cae mientras un agente trabaja, ese turno se pierde (el estado del workspace puede quedar a medias); la sesión vuelve en pausa desde el último turno completado. Con un cierre ordenado (Ctrl+C) los procesos de los agentes se detienen; si el servidor muere de golpe, pueden quedar huérfanos.
- **Detener no deshace.** Interrumpir a un agente deja en el workspace lo que hubiera escrito hasta ese momento; revisa el `git status` antes de reanudar.
- **Los agentes modifican archivos de verdad.** Usa un workspace bajo Git y revisa los diffs. OpenHands en modo headless auto‑aprueba todas sus acciones.
- **Cuotas.** Con el free tier de Gemini, varios agentes compartiendo la misma key pueden dar `429`; el arquitecto reintenta con espera, el resto reporta el error y el ciclo continúa.
