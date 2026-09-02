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
   ├─ parseVerdict()            solo arquitecto en REVIEW
   ├─ addMessage() → emit message → HistoryWriter.save()
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

`core/history-writer.ts` reescribe el `.md` completo de la conversación en cada cambio. Es síncrono y nunca lanza (un fallo de disco se registra y el ciclo sigue). Ruta: `conversations/<workspace>/<fecha>_<título>.md`.

No hay base de datos a propósito: el objetivo del proyecto es una herramienta local y auditable, y el Markdown es legible sin tooling.

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
└── orchestrator.test.ts         ciclo completo con adaptadores falsos
```

Usan `node:test` (sin dependencias) y no tocan red ni herramientas externas. `npm test` corre en ~1 s. `scripts/test-e2e.js` es la prueba real de extremo a extremo y sí requiere credenciales.

## 10. Decisiones que conviene conocer

- **`autoStopOnError=false` en el servidor.** Un agente caído no debe matar la sesión: se registra un mensaje de sistema y el arquitecto decide. En tests se puede activar para detectar fallos.
- **El arquitecto siempre está en el equipo** y siempre abre el ciclo. Sin él no hay plan ni veredicto, y el ciclo solo terminaría por `maxTurns`.
- **Round‑robin simple** en vez de que el arquitecto elija quién habla en cada turno: es predecible, fácil de razonar y suficiente para equipos de 2–4 agentes. Si hiciera falta un enrutado dinámico, el sitio es `agentForTurn()`.
- **Sin auto‑commits de Aider por defecto.** El usuario debe ver los diffs antes de que entren en el historial de Git.
- **Timeouts largos para CLIs** (5–10 min): OpenHands y Aider pueden tardar mucho en tareas reales. Se ajustan por variable.
