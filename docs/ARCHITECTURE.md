# Arquitectura y guía para desarrolladores

Este documento explica **cómo está construido** el bridge, **por qué** se tomaron ciertas decisiones y **cómo extenderlo**. Para instalar y usar, ver el [README](../README.md).

## 1. Visión general

El sistema tiene tres capas, con dependencias en una sola dirección:

```
server/  ──►  core/  ──►  adapters/
   │            │             │
   │            └──► agents/ (catálogo + registro)
   └──► web/ (cliente, solo habla con server/)

types/ y utils/ y config.ts pueden usarse desde cualquier capa.
```

| Capa | Responsabilidad | No debe… |
|---|---|---|
| `adapters/` | Hablar con una herramienta externa concreta. Recibe un `AgentTask`, devuelve Markdown. | Conocer conversaciones, turnos ni otros agentes. |
| `agents/` | Describir los agentes (catálogo) y construirlos (registro). | Contener lógica de ejecución. |
| `core/` | Reglas del juego: turnos, fases, prompts, veredictos, persistencia. | Saber de HTTP/WebSocket ni de herramientas concretas. |
| `server/` | Transporte: Express + WebSocket. Traduce comandos ↔ llamadas al orquestador. | Contener lógica de negocio. |
| `web/` | Panel. Todo lo que muestra de agentes lo obtiene de la API. | Tener nombres/roles de agentes escritos a mano. |

## 2. Flujo de un turno

```
Orchestrator.runLoop()
   │
   ├─ agentForTurn()            round-robin: agents[turn % agents.length]
   ├─ phaseForTurn()            core/phases.ts
   ├─ emit turn_change
   ├─ buildPrompt()             core/prompt-builder.ts
   ├─ adapter.sendMessage(task) adapters/*.ts   ← única llamada "lenta"
   ├─ parseTeamSelection()      solo turno 0 + modo autónomo
   ├─ parseVerdict() + parseNextAgent()   solo arquitecto en REVIEW
   ├─ addMessage() → emit message → persist() (.md + .json)
   └─ ¿APPROVED? → COMPLETED    ¿maxTurns? → COMPLETED    si no → siguiente turno
```

### Estados de una conversación

```
 idle ──start──► active ──pause──► paused ──resume──► active
                   │                                    │
                   └──── aprobado / maxTurns / error ───┴──► completed (o paused si error)
```

- `pauseLoop()` **no interrumpe** el turno en curso (no se puede cancelar una CLI a medias de forma segura); marca `paused` y el bucle no inicia otro turno.
- `resumeLoop()` mientras el turno en curso sigue vivo simplemente cancela la pausa. Si el bucle ya terminó, lo relanza. Nunca hay dos bucles para la misma conversación: lo garantiza el `Set` `running`.

## 3. Contrato de un adaptador

```ts
interface AgentAdapter {
  sendMessage(task: AgentTask): Promise<string>;   // Markdown con el resultado
  getStatus(): Promise<AdapterStatus>;             // { available, mode, detail }
  getSourceBackend(): string;                      // "Aider CLI · gemini/…"
}
```

Reglas que cumplen todos los adaptadores:

1. **Nunca lanzan por "herramienta no disponible".** Devuelven un Markdown explicando el problema; así el ciclo continúa y el arquitecto puede reasignar. Solo lanzan por errores inesperados (y aun así el orquestador los captura si `autoStopOnError=false`, que es el valor por defecto en el servidor).
2. **Respetan `task.projectPath`** como directorio de trabajo.
3. **No hacen `process.env`.** Reciben su bloque de `AppConfig` en el constructor.
4. **Recortan salidas enormes** (`truncateMiddle`) para no inflar el historial ni los prompts.

### `BaseCliAdapter`

Los tres adaptadores de CLI (OpenHands, Aider, Open Interpreter) extienden esta clase, que resuelve lo común:

- `getStatus()` con caché de 60 s (ejecuta `<cmd> --version`).
- Manejo de `ENOENT`, timeout (SIGTERM → SIGKILL) y código de salida ≠ 0.
- Cabecera Markdown uniforme (comando, workspace, duración, código de salida).

La subclase solo implementa `buildInvocation(task)` (qué ejecutar) y opcionalmente `extractAnswer(result)` (cómo limpiar la salida).

### Por qué cada herramienta se integra así

| Herramienta | Integración elegida | Alternativas descartadas |
|---|---|---|
| OpenCode | HTTP `POST /session/:id/message` con `?directory=` | CLI `opencode run`: menos control de sesión; el servidor es la interfaz oficial para clientes. |
| OpenHands | `openhands --headless --json -f task.md` | SDK Python: obligaría a un proceso puente. El CLI headless está diseñado para automatización y el JSONL da trazabilidad de acciones. |
| Aider | `aider --message-file task.md --yes-always --no-stream` | API Python (`Coder.create`): misma razón. `--message-file` evita límites de longitud de argumentos. |
| Open Interpreter | Paquete Python vía `scripts/interpreter_runner.py` (`interpreter.chat()` con `auto_run`); binario nuevo vía `interpreter exec -` si es lo que hay instalado | El CLI del paquete Python (`interpreter --stdin`) lee una sola línea con `input()` y trunca prompts multilínea. El runner recibe el prompt completo por stdin y devuelve JSON limpio (la salida del paquete se redirige a stderr). |
| Antigravity | REST directo a Gemini u OpenAI‑compatible | Ninguna dependencia de SDK: `fetch` nativo basta y se cambia de proveedor con una variable. |

### Qué se verificó y cómo

Cada adaptador se contrastó con la herramienta real o con su código fuente (ver `scripts/probe/README.md`):

- **Aider 0.86.2** — ejecutado de verdad contra un LLM falso: aplica ediciones, y descubrimos que sin `--no-auto-lint` reintenta con el LLM por cada error de lint (varias rondas por turno) y que escribe `.aider.*` en el workspace (se redirigen a `/tmp` y se excluyen vía `.git/info/exclude`).
- **Open Interpreter 0.4.3** — ejecutado de verdad: `interpreter.chat()` devuelve mensajes `{role, type, format, content}`; los de `format: "active_line"` son ruido de UI y se filtran.
- **OpenCode 1.18.26** — servidor real; el esquema OpenAPI (`GET /doc`) confirma `POST /session/:id/message {model, parts}` → `{info, parts}` y `?directory=`. El auto‑arranque con `detached: true` sobrevive al proceso padre.
- **OpenHands 1.16.0** — no se pudo ejecutar (exige Python 3.12 exacto); se leyó el wheel: los siete flags existen, el JSONL usa `kind` como discriminador (`ActionEvent`/`ObservationEvent`/`MessageEvent`) y, sin settings guardados, imprime "Headless mode requires existing settings" **con código de salida 0** — por eso el adaptador detecta ese texto en vez de fiarse del exit code.

## 4. Prompts

`core/prompt-builder.ts` construye un único prompt por turno con cuatro bloques: contexto, rol, objetivo original e historial reciente (últimos 6 mensajes, cada uno recortado a 6 000 caracteres). El objetivo original **siempre** va incluido para que no se pierda en sesiones largas.

El arquitecto tiene dos variantes: planificación (turno 0, con la petición de `[EQUIPO: …]` si es modo autónomo) y revisión (turno > 0, con la exigencia de la línea `VEREDICTO:`).

Para cambiar el comportamiento de un agente, edita `roleInstructions()`; no hace falta tocar nada más.

## 5. Veredicto y equipo

`core/verdict.ts` es la única pieza que "interpreta" texto libre del LLM:

- **Veredicto:** primero busca la línea explícita `VEREDICTO: APROBADO|REQUIERE_CAMBIOS`. Solo si no existe recurre a palabras sueltas, y en ese caso **cualquier palabra de rechazo pesa más** que una de aprobación ("APROBADO parcialmente, INCOMPLETO en X" no cierra el ciclo).
- **Equipo:** `[EQUIPO: a, b]` → lista de ids válidos, sin duplicados. El arquitecto se añade siempre.

Ambas funciones son puras y están cubiertas por tests.

## 6. Persistencia

Dos escrituras por cada cambio, ambas desde `Orchestrator.persist()`:

- `core/history-writer.ts` — el `.md` **legible** (`conversations/<workspace>/<fecha>_<título>.md`). Para leerlo, compartirlo, versionarlo.
- `core/session-store.ts` — el `.json` **recuperable** (`conversations/.sessions/<id>.json`, escritura atómica vía rename). Al arrancar, `Orchestrator.restore()` los carga; las sesiones que estaban `active` vuelven como `paused` con un mensaje de sistema, porque el bucle que las ejecutaba murió con el proceso. `reviveConversation()` rellena campos añadidos en versiones posteriores, así que los `.json` antiguos siguen cargando.

No hay base de datos a propósito: las sesiones son pocas y pequeñas, y un archivo por sesión se inspecciona y borra a mano. Ambos escritores son síncronos y nunca lanzan (un fallo de disco se registra y el ciclo sigue).

### Archivos del workspace

`core/workspace-files.ts` da al panel acceso **de solo lectura** al workspace de una sesión. Toda ruta pasa por `resolveInsideWorkspace()`: se rechazan `..`, las rutas absolutas se tratan como relativas, y se compara el `realpath` final con el del workspace para que un enlace simbólico no permita salir. El HTML generado por los agentes se sirve con `Content-Security-Policy: sandbox` y el panel lo muestra en un `<iframe sandbox="allow-scripts">`, de modo que un gráfico d3 funciona pero no puede tocar el panel.

## 6b. Skills

`src/skills/` implementa el estándar **Agent Skills** (`SKILL.md` con frontmatter `name`/`description` + cuerpo Markdown; opcionalmente `scripts/`, `references/`, `assets/`). Se eligió ese formato en vez de uno propio porque OpenHands (`load_project_skills`) y OpenCode (`/skill`) ya lo leen de `.agents/skills/` y porque existe un ecosistema de repositorios reutilizables.

Piezas:

| Módulo | Responsabilidad | Pureza |
|---|---|---|
| `skill-file.ts` | Parsear y validar un `SKILL.md` (reglas de `name`, recorte de `description` > 1024). | Pura salvo `readSkillFile`. |
| `skill-library.ts` | `sync()` (git clone/pull por fuente), `list()` (catálogo con prioridad local → bundled → remotas), `materialize()` (copia a `<ws>/.agents/skills/<name>` + `README.md` + `.git/info/exclude`). | Disco y `git`. |
| `skill-briefing.ts` | Texto para el arquitecto (catálogo + formato `[SKILLS: agente=a,b; …]`), `parseSkillAssignments`, y el dossier por agente (`renderBriefingForAgent`). | Pura. |
| `skill-search.ts` | Ranking léxico de skills frente a un objetivo: TF‑IDF sobre nombre+descripción, sinónimos es↔en del dominio, coincidencia débil por raíz para cognados (`literatura`~`literature`), bonificación a `local`/`bundled`. | Pura. |
| `skill-coordinator.ts` | Lo que llama el orquestador: sección de planificación (catálogo completo si ≤30 skills, si no las 25 más relevantes + las fijadas por el usuario), aplicar la etiqueta del arquitecto, preparar el turno (materializar + dossier). Con biblioteca ausente es neutro. | Orquesta las anteriores. |

Decisiones:

- **Dos vías de entrega según el agente.** `AgentDescriptor.loadsSkillsNatively` decide si el dossier es una referencia corta a la carpeta (OpenHands, OpenCode) o si se inyecta el cuerpo de la skill en el prompt con presupuesto de caracteres (Aider, Open Interpreter, Antigravity). Así no se duplica contexto para quien ya lo carga.
- **OpenCode cachea el escaneo de skills por directorio.** Verificado en 1.18.26: las skills copiadas después de que el servidor conozca el workspace no aparecen hasta `POST /instance/dispose` (las sesiones siguen vivas). El adaptador lo hace cuando cambia el conjunto de skills del workspace.
- **El usuario manda.** Las asignaciones del formulario se conservan; el arquitecto solo puede añadir (máximo 3 por agente, solo nombres del catálogo, solo agentes del equipo).
- **Descripción como contrato.** El arquitecto decide solo con `name` + `description` (progressive disclosure del estándar); una skill con descripción vaga no se asignará bien. Las incluidas en `skills/` siguen la regla "qué hace y cuándo usarla".
- **Preselección sin LLM.** Con 4 repositorios hay ~400 skills (≈100 000 caracteres de catálogo): demasiado para un turno. El ranking léxico descarta el 90 % irrelevante en ~30 ms y sin red; la precisión final la pone el arquitecto sobre las ~25 restantes. La etiqueta `[SKILLS: …]` acepta cualquier nombre de la biblioteca, no solo los mostrados, por si el arquitecto conoce uno.
- **Frontmatter tolerante.** Muchas skills de GitHub tienen YAML no estricto (`description: Guides through: 1) …`). Si el parser YAML falla, un lector `clave: resto de línea` recupera `name`/`description` en vez de descartar la skill.
- **Licencias visibles, no filtradas.** El catálogo muestra `license`; no se bloquea ninguna porque el uso legítimo depende del contexto del usuario.

## 7. Panel web

`web/app.js` es JavaScript sin framework, organizado en: estado → WebSocket → render → acciones → arranque. Principios:

- **Cero datos de agentes escritos a mano.** Nombres, roles, emojis y checkboxes se generan desde el evento `connected`. Los colores se resuelven con variables CSS `--agent-<id>` (añadir un agente = añadir una variable).
- **Markdown sanitizado.** `marked` → `DOMPurify` antes de insertar en el DOM.
- **Librerías servidas en local** desde `node_modules` (`/vendor/*`), sin CDN: el panel funciona sin internet.

## 8. Cómo añadir un agente

Ejemplo: integrar **Cline** como CLI hipotética `cline --task "..."`.

1. `src/types/index.ts` → añade `'cline'` a `AgentType`.
2. `src/agents/catalog.ts` → añade la entrada con `name`, `role`, `emoji`, `shortLabel`; añádelo a `AGENT_ORDER`.
3. `src/core/phases.ts` → decide su fase (normalmente `DEVELOPMENT`). TypeScript te obligará porque el `switch` es exhaustivo.
4. `src/core/prompt-builder.ts` → añade sus instrucciones en `roleInstructions()` (también exhaustivo).
5. `src/config.ts` y `.env.example` → bloque `cline: { command, model, timeoutMs }`.
6. `src/adapters/cline.ts`:
   ```ts
   export class ClineAdapter extends BaseCliAdapter {
     constructor(private readonly config: AppConfig['cline']) {
       super('🧩 Cline', config.command, config.timeoutMs);
     }
     getSourceBackend() { return `Cline CLI · ${this.config.model}`; }
     protected buildInvocation(task: AgentTask): CliInvocation {
       return { command: this.config.command, args: ['--task', task.prompt] };
     }
   }
   ```
7. `src/agents/registry.ts` → `registry.register('cline', new ClineAdapter(config.cline))`.
8. `src/web/styles.css` → `--agent-cline: #color;`.
9. Añade un test si el adaptador parsea salida (ver `tests/openhands-parser.test.ts`).

Si en vez de una CLI es una API HTTP, implementa `AgentAdapter` directamente (ver `opencode.ts` como referencia).

## 9. Pruebas

```
tests/
├── verdict.test.ts              parseo de veredicto y equipo
├── phases.test.ts               regla de fases
├── prompt-builder.test.ts       contenido del prompt por rol/modo
├── config.test.ts               defaults y precedencia de variables
├── interpreter.test.ts          lista blanca de comandos del fallback y parseo del runner
├── openhands-parser.test.ts     parseo JSONL
├── skills.test.ts               SKILL.md, biblioteca en disco, asignación y dossiers
├── skill-search.test.ts         ranking es/en, sinónimos, cognados, pinned
├── session-store.test.ts        guardar/recuperar, reinicio simulado y reanudación
├── workspace-files.test.ts      listado, confinamiento de rutas (.., symlinks), MIME
└── orchestrator.test.ts         ciclo completo con adaptadores falsos, [SIGUIENTE]
```

Usan `node:test` (sin dependencias) y no tocan red ni herramientas externas. `npm test` corre en ~1 s. `scripts/test-e2e.js` es la prueba real de extremo a extremo y sí requiere credenciales.

## 10. Decisiones que conviene conocer

- **`autoStopOnError=false` en el servidor.** Un agente caído no debe matar la sesión: se registra un mensaje de sistema y el arquitecto decide. En tests se puede activar para detectar fallos.
- **El arquitecto siempre está en el equipo** y siempre abre el ciclo. Sin él no hay plan ni veredicto, y el ciclo solo terminaría por `maxTurns`.
- **Round‑robin con excepción explícita.** El orden base es predecible y fácil de razonar; el arquitecto solo lo altera con `[SIGUIENTE: id]` en una revisión con `REQUIERE_CAMBIOS`. `agentForTurn()` consume esa indicación una vez y **rota** `conversation.agents` para que el ciclo continúe desde el agente elegido (si no, el siguiente turno volvería a caer en quien iba antes). Con `APROBADO` la etiqueta se ignora porque el ciclo termina.
- **Sin auto‑commits de Aider por defecto.** El usuario debe ver los diffs antes de que entren en el historial de Git.
- **Timeouts largos para CLIs** (5–10 min): OpenHands y Aider pueden tardar mucho en tareas reales. Se ajustan por variable.
