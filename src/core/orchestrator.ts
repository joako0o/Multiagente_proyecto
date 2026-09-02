/**
 * Orquestador: gestiona las conversaciones y ejecuta el ciclo de turnos.
 *
 * Ciclo de vida de una conversación:
 *
 *   createConversation()  → status `idle`
 *   startLoop(prompt)     → status `active`, arranca runLoop()
 *   pauseLoop()           → status `paused` (el turno en curso termina, no se inicia otro)
 *   resumeLoop()          → status `active`, arranca runLoop() de nuevo
 *   [objetivo alcanzado o maxTurns] → status `completed`
 *
 * runLoop() en cada iteración:
 *   1. elige el agente por round-robin,
 *   2. actualiza la fase,
 *   3. construye el prompt y llama al adaptador,
 *   4. guarda la respuesta, interpreta el veredicto/equipo,
 *   5. decide si continuar.
 *
 * Emite eventos (`ServerEvent`) que el servidor WebSocket reenvía al panel.
 */
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import {
  Agent,
  Conversation,
  ConversationMessage,
  ConversationPhase,
  ConversationSummary,
  LoopOptions,
  MessageMetadata,
  MessageRole,
  OrchestrationMode,
  ServerEvent
} from '../types';
import { AgentRegistry } from '../agents/registry';
import { ARCHITECT_ID, DEFAULT_TEAM } from '../agents/catalog';
import { HistoryWriter } from './history-writer';
import { SessionStore } from './session-store';
import { buildPrompt } from './prompt-builder';
import { phaseForTurn } from './phases';
import { parseNextAgent, parseTeamSelection, parseVerdict } from './verdict';
import { normalizeProjectPath } from '../utils/paths';
import { SkillCoordinator } from '../skills/skill-coordinator';

export interface CreateConversationInput {
  title: string;
  agentIds?: string[];
  projectPath?: string;
  orchestrationMode?: OrchestrationMode;
  maxTurns?: number;
  /** Asignación manual de skills (`agentId → nombres`). */
  skills?: Record<string, string[]>;
}

export interface OrchestratorDeps {
  registry: AgentRegistry;
  /** Historial legible (`.md`) por sesión. */
  history: HistoryWriter;
  /** Estado recuperable (`.json`) por sesión. Opcional: sin él, las sesiones viven solo en memoria. */
  store?: SessionStore;
  skills?: SkillCoordinator;
  defaults: LoopOptions;
}

export class Orchestrator extends EventEmitter {
  private readonly conversations = new Map<string, Conversation>();
  /** Conversaciones con un runLoop() en ejecución. Evita solapar ciclos. */
  private readonly running = new Set<string>();
  private readonly registry: AgentRegistry;
  private readonly history: HistoryWriter;
  private readonly store?: SessionStore;
  private readonly skills: SkillCoordinator;
  private readonly defaults: LoopOptions;

  constructor(deps: OrchestratorDeps) {
    super();
    this.registry = deps.registry;
    this.history = deps.history;
    this.store = deps.store;
    this.defaults = deps.defaults;
    // Sin biblioteca configurada, el coordinador es neutro (no añade nada a los prompts).
    this.skills = deps.skills ?? new SkillCoordinator(undefined);
  }

  /** Recupera las sesiones guardadas por el `SessionStore` (llamar una vez al arrancar). */
  restore(): number {
    if (!this.store) return 0;
    const restored = this.store.loadAll();
    for (const conversation of restored) {
      this.conversations.set(conversation.id, conversation);
    }
    return restored.length;
  }

  /** Guarda el `.md` legible y el `.json` recuperable. */
  private persist(conversation: Conversation): void {
    this.history.save(conversation);
    this.store?.save(conversation);
  }

  // ---------------------------------------------------------------------------
  // Consultas
  // ---------------------------------------------------------------------------

  getConversation(id: string): Conversation | undefined {
    return this.conversations.get(id);
  }

  listConversations(): ConversationSummary[] {
    return [...this.conversations.values()].map(summarize);
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  // ---------------------------------------------------------------------------
  // Comandos
  // ---------------------------------------------------------------------------

  createConversation(input: CreateConversationInput): Conversation {
    const requested = (input.agentIds ?? []).filter(id => this.registry.has(id));
    const agents = requested.length ? requested : [...DEFAULT_TEAM];
    // El arquitecto siempre participa y siempre abre el ciclo.
    if (!agents.includes(ARCHITECT_ID)) agents.unshift(ARCHITECT_ID);

    const now = new Date();
    const conversation: Conversation = {
      id: uuidv4(),
      title: input.title.trim() || 'Sesión sin título',
      agents,
      messages: [],
      status: 'idle',
      phase: 'PLANNING',
      orchestrationMode: input.orchestrationMode ?? 'manual',
      projectPath: normalizeProjectPath(input.projectPath),
      currentTurn: 0,
      maxTurns: clampTurns(input.maxTurns ?? this.defaults.maxTurns),
      skills: this.skills.sanitizeAssignments(input.skills, this.registry),
      createdAt: now,
      updatedAt: now
    };

    this.conversations.set(conversation.id, conversation);
    this.persist(conversation);
    return conversation;
  }

  /** Añade un mensaje (del usuario, de un agente o del sistema) y lo difunde. */
  addMessage(conversationId: string, agentId: string, content: string, role: MessageRole, metadata?: MessageMetadata): ConversationMessage {
    const conversation = this.require(conversationId);
    const message: ConversationMessage = {
      id: uuidv4(),
      conversationId,
      agentId,
      content,
      timestamp: new Date(),
      role,
      metadata
    };
    conversation.messages.push(message);
    conversation.updatedAt = message.timestamp;
    this.persist(conversation);
    this.emitEvent({ type: 'message', conversationId, data: message });
    return message;
  }

  startLoop(conversationId: string, initialPrompt: string, options: Partial<LoopOptions> = {}): void {
    const conversation = this.require(conversationId);
    if (this.running.has(conversationId)) {
      throw new Error('Ya hay un ciclo en ejecución para esta conversación');
    }
    if (conversation.status === 'completed') {
      throw new Error('La conversación ya está completada; crea una nueva');
    }

    if (options.maxTurns) conversation.maxTurns = clampTurns(options.maxTurns);
    this.addMessage(conversationId, 'user', initialPrompt.trim(), 'user', {
      phase: conversation.phase,
      projectPath: conversation.projectPath,
      orchestrationMode: conversation.orchestrationMode
    });

    this.launch(conversation, options);
  }

  pauseLoop(conversationId: string): void {
    const conversation = this.require(conversationId);
    if (conversation.status !== 'active') return;
    // El turno en curso terminará; runLoop() comprobará el estado antes del siguiente.
    this.setStatus(conversation, 'paused');
  }

  resumeLoop(conversationId: string, options: Partial<LoopOptions> = {}): void {
    const conversation = this.require(conversationId);
    if (conversation.status === 'completed') {
      throw new Error('No se puede reanudar una conversación completada');
    }
    if (this.running.has(conversationId)) {
      if (conversation.status === 'paused') {
        // La pausa se pidió pero el turno en curso aún no ha terminado:
        // basta con cancelarla y el ciclo sigue sin interrupción.
        this.setStatus(conversation, 'active');
        return;
      }
      throw new Error('El ciclo ya está en ejecución');
    }
    if (conversation.messages.length === 0) {
      throw new Error('La conversación no tiene objetivo; usa "iniciar" en lugar de "reanudar"');
    }
    this.launch(conversation, options);
  }

  // ---------------------------------------------------------------------------
  // Ciclo de turnos
  // ---------------------------------------------------------------------------

  private launch(conversation: Conversation, options: Partial<LoopOptions>): void {
    const loopOptions: LoopOptions = { ...this.defaults, ...options };
    this.setStatus(conversation, 'active');
    this.running.add(conversation.id);

    this.runLoop(conversation, loopOptions)
      .catch((err: Error) => {
        console.error(`[Orchestrator] ciclo interrumpido: ${err.message}`);
        this.addMessage(conversation.id, 'system', `⚠️ Ciclo interrumpido: ${err.message}`, 'system');
        this.setStatus(conversation, 'paused');
        this.emitEvent({ type: 'error', conversationId: conversation.id, data: { message: err.message } });
      })
      .finally(() => {
        this.running.delete(conversation.id);
      });
  }

  private async runLoop(conversation: Conversation, options: LoopOptions): Promise<void> {
    while (conversation.status === 'active' && conversation.currentTurn < conversation.maxTurns) {
      const agent = this.agentForTurn(conversation);
      const phase = phaseForTurn(conversation.currentTurn, agent.type);
      this.setPhase(conversation, phase);

      this.emitEvent({
        type: 'turn_change',
        conversationId: conversation.id,
        data: {
          turn: conversation.currentTurn,
          agentId: agent.id,
          agentName: agent.name,
          phase,
          sourceBackend: agent.adapter.getSourceBackend()
        }
      });

      const goalReached = await this.executeTurn(conversation, agent, options);

      conversation.currentTurn++;
      conversation.updatedAt = new Date();
      this.persist(conversation);

      if (goalReached) {
        this.setPhase(conversation, 'COMPLETED');
        this.setStatus(conversation, 'completed');
        return;
      }

      if (conversation.status === 'active' && options.delayBetweenTurnsMs > 0) {
        await sleep(options.delayBetweenTurnsMs);
      }
    }

    if (conversation.status === 'active') {
      // Se agotaron los turnos sin aprobación.
      this.addMessage(conversation.id, 'system',
        `⏹️ Se alcanzó el máximo de ${conversation.maxTurns} turnos sin veredicto de aprobación. Puedes crear una nueva sesión con más turnos o un objetivo más acotado.`,
        'system');
      this.setStatus(conversation, 'completed');
    }
  }

  /**
   * Ejecuta el turno de un agente. Devuelve `true` si el arquitecto aprobó
   * el trabajo (fin del ciclo).
   */
  private async executeTurn(conversation: Conversation, agent: Agent, options: LoopOptions): Promise<boolean> {
    const team = conversation.agents.map(id => this.registry.get(id)).filter((a): a is Agent => Boolean(a));
    const isArchitect = agent.id === ARCHITECT_ID;
    const isPlanningTurn = isArchitect && conversation.currentTurn === 0;

    // Skills: el arquitecto ve el catálogo en planificación; cada agente recibe su dossier.
    const skillsSection = isPlanningTurn
      ? this.skills.sectionForArchitect(conversation)
      : this.skills.prepareTurn(conversation, agent);

    const prompt = buildPrompt({
      conversation,
      agent,
      team,
      displayName: id => this.registry.displayName(id),
      skillsSection
    });

    let response: string;
    try {
      response = await agent.adapter.sendMessage({
        conversationId: conversation.id,
        prompt,
        skills: this.skills.skillsFor(conversation, agent.id),
        projectPath: conversation.projectPath,
        phase: conversation.phase,
        orchestrationMode: conversation.orchestrationMode,
        turn: conversation.currentTurn
      });
    } catch (err) {
      const message = (err as Error).message;
      if (options.autoStopOnError) throw new Error(`${agent.name}: ${message}`);
      this.addMessage(conversation.id, 'system', `⚠️ ${agent.name} falló en este turno: ${message}`, 'system');
      return false;
    }

    const metadata: MessageMetadata = {
      phase: conversation.phase,
      sourceBackend: agent.adapter.getSourceBackend()
    };

    if (isPlanningTurn && conversation.orchestrationMode === 'autonomous') {
      this.applyTeamSelection(conversation, response);
    }
    if (isPlanningTurn) {
      const summary = this.skills.applyArchitectAssignments(conversation, response, this.registry);
      if (summary) {
        console.log(`[Orchestrator] skills asignadas por el arquitecto: ${summary}`);
        this.addMessage(conversation.id, 'system', `🧰 Skills asignadas — ${summary}`, 'system');
      }
    }

    let goalReached = false;
    if (isArchitect && conversation.phase === 'REVIEW') {
      const verdict = parseVerdict(response);
      if (verdict) metadata.verdict = verdict;
      goalReached = verdict === 'APPROVED';
      metadata.goalReached = goalReached;

      // El arquitecto puede saltarse el round-robin y pasar el turno a quien deba corregir.
      const next = parseNextAgent(response, id => conversation.agents.includes(id) && id !== ARCHITECT_ID);
      if (next && !goalReached) {
        conversation.nextAgentId = next;
        console.log(`[Orchestrator] el arquitecto pasa el turno a ${this.registry.displayName(next)}`);
      }
    }

    this.addMessage(conversation.id, agent.id, response, 'agent', metadata);
    return goalReached;
  }

  private applyTeamSelection(conversation: Conversation, response: string): void {
    const selected = parseTeamSelection(response, id => this.registry.has(id));
    if (!selected) return;
    if (!selected.includes(ARCHITECT_ID)) selected.unshift(ARCHITECT_ID);

    conversation.agents = selected;
    const names = selected.map(id => this.registry.displayName(id)).join(', ');
    console.log(`[Orchestrator] equipo elegido por el arquitecto: ${names}`);
    this.addMessage(conversation.id, 'system', `🧠 El arquitecto definió el equipo: ${names}`, 'system');
  }

  /**
   * Agente del turno actual. Por defecto round-robin sobre `conversation.agents`;
   * si el arquitecto pidió `[SIGUIENTE: id]` en su última revisión, ese agente
   * toma el turno (una sola vez) y el round-robin continúa desde él.
   */
  private agentForTurn(conversation: Conversation): Agent {
    let id = conversation.agents[conversation.currentTurn % conversation.agents.length];

    if (conversation.nextAgentId && conversation.agents.includes(conversation.nextAgentId)) {
      id = conversation.nextAgentId;
      // Realineamos el round-robin para que el siguiente turno sea el agente que va después del elegido.
      const offset = conversation.agents.indexOf(id) - (conversation.currentTurn % conversation.agents.length);
      conversation.agents = rotate(conversation.agents, offset);
    }
    conversation.nextAgentId = undefined;

    const agent = this.registry.get(id);
    if (!agent) throw new Error(`Agente desconocido: ${id}`);
    return agent;
  }

  // ---------------------------------------------------------------------------
  // Estado y eventos
  // ---------------------------------------------------------------------------

  private setPhase(conversation: Conversation, phase: ConversationPhase): void {
    if (conversation.phase === phase) return;
    conversation.phase = phase;
    this.persist(conversation);
    this.emitEvent({ type: 'phase_change', conversationId: conversation.id, data: { phase, turn: conversation.currentTurn } });
  }

  private setStatus(conversation: Conversation, status: Conversation['status']): void {
    if (conversation.status === status) return;
    conversation.status = status;
    conversation.updatedAt = new Date();
    this.persist(conversation);
    this.emitEvent({
      type: 'status',
      conversationId: conversation.id,
      data: { status, turns: conversation.currentTurn, phase: conversation.phase }
    });
  }

  private emitEvent(event: ServerEvent): void {
    this.emit('event', event);
  }

  private require(conversationId: string): Conversation {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error(`Conversación no encontrada: ${conversationId}`);
    return conversation;
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

export function summarize(c: Conversation): ConversationSummary {
  return {
    id: c.id,
    title: c.title,
    status: c.status,
    phase: c.phase,
    orchestrationMode: c.orchestrationMode,
    projectPath: c.projectPath,
    agents: c.agents,
    currentTurn: c.currentTurn,
    maxTurns: c.maxTurns,
    messageCount: c.messages.length,
    skills: c.skills,
    updatedAt: c.updatedAt
  };
}

/** Rota una lista `offset` posiciones a la izquierda (offset negativo = derecha). */
function rotate<T>(items: T[], offset: number): T[] {
  if (!items.length) return items;
  const k = ((offset % items.length) + items.length) % items.length;
  return [...items.slice(k), ...items.slice(0, k)];
}

function clampTurns(value: number): number {
  if (!Number.isFinite(value)) return 15;
  return Math.min(100, Math.max(2, Math.floor(value)));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
