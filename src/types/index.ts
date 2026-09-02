/**
 * Tipos de dominio compartidos por todo el proyecto.
 *
 * Regla general: este archivo NO contiene lógica, solo contratos. Si un tipo
 * se usa en más de un módulo, vive aquí; si es interno a un módulo, vive allí.
 */

// ---------------------------------------------------------------------------
// Agentes
// ---------------------------------------------------------------------------

/**
 * Identificador del tipo de agente. Cada tipo tiene:
 *  - un adaptador en `src/adapters/<tipo>.ts` (cómo hablar con la herramienta), y
 *  - una entrada en `src/agents/catalog.ts` (nombre, rol, icono).
 */
export type AgentType = 'antigravity' | 'opencode' | 'openhands' | 'aider' | 'interpreter';

/** Metadatos "presentables" de un agente (lo que ve el panel web y el historial). */
export interface AgentDescriptor {
  /** Identificador estable. Coincide con `type` para los agentes por defecto. */
  id: string;
  /** Nombre visible, p. ej. "OpenHands". */
  name: string;
  type: AgentType;
  /** Descripción corta del rol dentro del equipo. */
  role: string;
  /** Emoji usado en el panel y en los `.md` de historial. */
  emoji: string;
  /** Etiqueta breve del backend, p. ej. "CLI headless". */
  shortLabel: string;
  /**
   * `true` si la herramienta carga por sí misma las skills de `.agents/skills/`
   * (OpenHands, OpenCode). Si es `false`, el orquestador inyecta las
   * instrucciones de la skill en el prompt.
   */
  loadsSkillsNatively: boolean;
}

/** Estado de disponibilidad de un adaptador. */
export interface AdapterStatus {
  /** `true` si el agente puede atender turnos ahora mismo. */
  available: boolean;
  /** Modo de funcionamiento actual, p. ej. "cli", "api", "fallback". */
  mode: string;
  /** Texto libre con detalles útiles para el usuario (versión, motivo de indisponibilidad…). */
  detail?: string;
}

/** Lo que recibe un adaptador cuando le toca el turno. */
export interface AgentTask {
  conversationId: string;
  /** Prompt completo ya construido por `prompt-builder.ts` (incluye el dossier de skills). */
  prompt: string;
  /** Nombres de las skills asignadas a este agente en esta sesión (ya materializadas en el workspace). */
  skills: string[];
  /** Directorio de trabajo del proyecto sobre el que actúa el agente. */
  projectPath: string;
  phase: ConversationPhase;
  orchestrationMode: OrchestrationMode;
  /** Índice de turno (base 0). */
  turn: number;
}

/**
 * Contrato que debe cumplir cualquier integración con una herramienta externa.
 * Para añadir un agente nuevo basta con implementar esta interfaz y registrarlo
 * en `src/agents/registry.ts`.
 */
export interface AgentAdapter {
  /** Ejecuta la tarea y devuelve la respuesta del agente en Markdown. */
  sendMessage(task: AgentTask): Promise<string>;
  /** Comprueba si la herramienta está instalada/configurada. Debe ser rápido y nunca lanzar. */
  getStatus(): Promise<AdapterStatus>;
  /** Descripción del backend real que atiende (se muestra junto a cada mensaje). */
  getSourceBackend(): string;
}

/** Agente completo = metadatos + adaptador. */
export interface Agent extends AgentDescriptor {
  adapter: AgentAdapter;
}

// ---------------------------------------------------------------------------
// Conversaciones
// ---------------------------------------------------------------------------

/**
 * Fases del ciclo de trabajo. La fase la decide el orquestador según el agente
 * que tiene el turno (ver `src/core/phases.ts`).
 */
export type ConversationPhase = 'PLANNING' | 'DEVELOPMENT' | 'EXECUTION' | 'REVIEW' | 'COMPLETED';

/** Veredicto que emite el arquitecto en fase de revisión. */
export type Verdict = 'APPROVED' | 'CHANGES_REQUESTED';

/**
 * - `manual`: el usuario elige qué agentes participan.
 * - `autonomous`: el arquitecto elige el equipo en el primer turno mediante la
 *   etiqueta `[EQUIPO: ...]` (ver `src/core/verdict.ts`).
 */
export type OrchestrationMode = 'manual' | 'autonomous';

/**
 * - `idle`: creada, sin ciclo iniciado.
 * - `active`: ciclo en ejecución.
 * - `paused`: detenida por el usuario o por un error; se puede reanudar.
 * - `completed`: objetivo alcanzado o máximo de turnos agotado.
 */
export type ConversationStatus = 'idle' | 'active' | 'paused' | 'completed';

export type MessageRole = 'user' | 'agent' | 'system';

export interface MessageMetadata {
  phase?: ConversationPhase;
  verdict?: Verdict;
  /** `true` en el mensaje que cerró la conversación con éxito. */
  goalReached?: boolean;
  /** Backend real que generó la respuesta (ver `AgentAdapter.getSourceBackend`). */
  sourceBackend?: string;
  projectPath?: string;
  orchestrationMode?: OrchestrationMode;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  /** Id del agente, o `user` / `system`. */
  agentId: string;
  content: string;
  timestamp: Date;
  role: MessageRole;
  metadata?: MessageMetadata;
}

export interface Conversation {
  id: string;
  title: string;
  /** Ids de los agentes que participan, en orden de turno (round-robin). */
  agents: string[];
  messages: ConversationMessage[];
  status: ConversationStatus;
  phase: ConversationPhase;
  orchestrationMode: OrchestrationMode;
  projectPath: string;
  /** Turnos ya ejecutados. */
  currentTurn: number;
  maxTurns: number;
  /**
   * Skills asignadas por agente (`agentId → nombres`). Las fija el arquitecto
   * en el turno de planificación con `[SKILLS: …]` o el usuario al crear la sesión.
   */
  skills: Record<string, string[]>;
  /**
   * Agente que debe tomar el próximo turno, si el arquitecto lo indicó con
   * `[SIGUIENTE: id]` en su revisión. Se consume al usarse; sin él, round-robin.
   */
  nextAgentId?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Resumen ligero de una conversación (listados, evento `connected`). */
export interface ConversationSummary {
  id: string;
  title: string;
  status: ConversationStatus;
  phase: ConversationPhase;
  orchestrationMode: OrchestrationMode;
  projectPath: string;
  agents: string[];
  currentTurn: number;
  maxTurns: number;
  messageCount: number;
  skills: Record<string, string[]>;
  updatedAt: Date;
}

/** Parámetros ajustables de un ciclo de turnos. */
export interface LoopOptions {
  maxTurns: number;
  delayBetweenTurnsMs: number;
  /** Si `true`, una excepción de un adaptador pausa la conversación. */
  autoStopOnError: boolean;
}

/** Ficha de una skill tal como la ve el panel (sin rutas internas). */
export interface SkillSummary {
  name: string;
  description: string;
  sourceId: string;
  license?: string;
  fileCount: number;
}

// ---------------------------------------------------------------------------
// Eventos servidor → cliente (WebSocket)
// ---------------------------------------------------------------------------

export interface TurnChangeData {
  turn: number;
  agentId: string;
  agentName: string;
  phase: ConversationPhase;
  sourceBackend: string;
}

export type ServerEvent =
  | { type: 'connected'; data: { agents: AgentDescriptor[]; conversations: ConversationSummary[]; skills: SkillSummary[] } }
  | { type: 'conversation_created'; conversationId: string; data: Conversation }
  | { type: 'message'; conversationId: string; data: ConversationMessage }
  | { type: 'turn_change'; conversationId: string; data: TurnChangeData }
  | { type: 'phase_change'; conversationId: string; data: { phase: ConversationPhase; turn: number } }
  | { type: 'status'; conversationId: string; data: { status: ConversationStatus; turns: number; phase: ConversationPhase } }
  | { type: 'error'; conversationId?: string; data: { message: string } };

// ---------------------------------------------------------------------------
// Comandos cliente → servidor (WebSocket)
// ---------------------------------------------------------------------------

export interface CreateConversationCommand {
  title?: string;
  agentIds?: string[];
  projectPath?: string;
  orchestrationMode?: OrchestrationMode;
  maxTurns?: number;
  /** Asignación manual de skills (`agentId → nombres`). En modo autónomo el arquitecto puede ampliarla. */
  skills?: Record<string, string[]>;
}

export interface StartLoopCommand {
  conversationId: string;
  initialPrompt: string;
  options?: Partial<LoopOptions>;
}

export type ClientCommand =
  | { type: 'create_conversation'; data: CreateConversationCommand }
  | { type: 'start_loop'; data: StartLoopCommand }
  | { type: 'send_message'; data: { conversationId: string; content: string } }
  | { type: 'pause_loop'; data: { conversationId: string } }
  | { type: 'resume_loop'; data: { conversationId: string; options?: Partial<LoopOptions> } };
