import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import {
  Agent,
  Conversation,
  ConversationMessage,
  ConversationPhase,
  ChatEvent,
  TurnConfig,
  OrchestrationMode
} from '../types';

export class ConversationManager extends EventEmitter {
  private conversations: Map<string, Conversation> = new Map();
  private agents: Map<string, Agent> = new Map();
  private activeLoops: Map<string, boolean> = new Map();
  private historyDir: string;

  private defaultTurnConfig: TurnConfig = {
    maxTurns: 20,
    delayBetweenTurns: 3000,
    autoStopOnError: true
  };

  constructor() {
    super();
    this.historyDir = join(process.cwd(), 'conversations');
    if (!existsSync(this.historyDir)) {
      mkdirSync(this.historyDir, { recursive: true });
    }
  }

  registerAgent(agent: Agent): void {
    this.agents.set(agent.id, agent);
  }

  getAgent(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  getAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  createConversation(
    title: string,
    agentIds: string[],
    projectPath?: string,
    orchestrationMode: OrchestrationMode = 'manual',
    maxTurns?: number
  ): Conversation {
    const cleanProjectPath = projectPath ? projectPath.replace(/^["']|["']$/g, '').trim() : process.cwd();
    const conversation: Conversation = {
      id: uuidv4(),
      title,
      agents: agentIds.length > 0 ? agentIds : ['antigravity', 'opencode'],
      messages: [],
      status: 'active',
      phase: 'PLANNING',
      orchestrationMode,
      projectPath: cleanProjectPath || process.cwd(),
      currentTurn: 0,
      maxTurns: maxTurns || this.defaultTurnConfig.maxTurns,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    this.conversations.set(conversation.id, conversation);
    this.saveMarkdown(conversation);
    return conversation;
  }

  getConversation(id: string): Conversation | undefined {
    return this.conversations.get(id);
  }

  getAllConversations(): Conversation[] {
    return Array.from(this.conversations.values());
  }

  async addMessage(
    conversationId: string,
    agentId: string,
    content: string,
    type: 'user' | 'agent' | 'system' = 'agent',
    metadata?: Record<string, any>
  ): Promise<ConversationMessage> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    const message: ConversationMessage = {
      id: uuidv4(),
      conversationId,
      agentId,
      content,
      timestamp: new Date(),
      type,
      metadata
    };

    conversation.messages.push(message);
    conversation.updatedAt = new Date();

    this.saveMarkdown(conversation);

    this.emit('message', {
      type: 'message',
      conversationId,
      data: message
    } as ChatEvent);

    return message;
  }

  setPhase(conversationId: string, phase: ConversationPhase): void {
    const conversation = this.conversations.get(conversationId);
    if (conversation && conversation.phase !== phase) {
      conversation.phase = phase;
      this.saveMarkdown(conversation);
      this.emit('phase_change', {
        type: 'phase_change',
        conversationId,
        data: { phase, turn: conversation.currentTurn }
      } as ChatEvent);
    }
  }

  async startLoop(
    conversationId: string,
    initialPrompt: string,
    config?: Partial<TurnConfig>
  ): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    if (this.activeLoops.get(conversationId)) {
      throw new Error(`Loop already active for conversation ${conversationId}`);
    }

    const turnConfig = { ...this.defaultTurnConfig, ...config };
    this.activeLoops.set(conversationId, true);

    conversation.maxTurns = turnConfig.maxTurns;
    if (turnConfig.projectPath) {
      conversation.projectPath = turnConfig.projectPath;
    }
    if (turnConfig.orchestrationMode) {
      conversation.orchestrationMode = turnConfig.orchestrationMode;
    }

    await this.addMessage(conversationId, 'user', initialPrompt, 'user', {
      phase: 'PLANNING',
      projectPath: conversation.projectPath,
      orchestrationMode: conversation.orchestrationMode
    });

    this.runLoop(conversationId, turnConfig).catch((error) => {
      console.error('Loop error:', error);
      this.activeLoops.set(conversationId, false);
      conversation.status = 'paused';
      this.saveMarkdown(conversation);

      this.emit('error', {
        type: 'error',
        conversationId,
        data: { error: error.message }
      } as ChatEvent);
    });
  }

  private async runLoop(
    conversationId: string,
    config: TurnConfig
  ): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;

    while (
      this.activeLoops.get(conversationId) &&
      conversation.currentTurn < conversation.maxTurns
    ) {
      const agentIndex = conversation.currentTurn % conversation.agents.length;
      const agentId = conversation.agents[agentIndex];
      const agent = this.agents.get(agentId);

      if (!agent) {
        throw new Error(`Agent ${agentId} not found`);
      }

      // Update Phase according to agent role & turn
      if (conversation.currentTurn === 0) {
        this.setPhase(conversationId, 'PLANNING');
      } else if (agent.type === 'opencode') {
        this.setPhase(conversationId, 'DEVELOPMENT');
      } else if (agent.type === 'interpreter') {
        this.setPhase(conversationId, 'EXECUTION');
      } else if (agent.type === 'aider') {
        this.setPhase(conversationId, 'DEVELOPMENT');
      } else if (agent.type === 'antigravity') {
        this.setPhase(conversationId, 'REVIEW');
      }

      this.emit('turn_change', {
        type: 'turn_change',
        conversationId,
        data: {
          turn: conversation.currentTurn,
          agentId,
          agentName: agent.name,
          phase: conversation.phase,
          sourceBackend: agent.adapter.getSourceBackend ? agent.adapter.getSourceBackend!() : agent.name
        }
      } as ChatEvent);

      const lastMessage = conversation.messages[conversation.messages.length - 1];
      const contextMessage: ConversationMessage = {
        id: uuidv4(),
        conversationId,
        agentId: 'system',
        content: this.buildContext(conversation, agent, lastMessage?.content || ''),
        timestamp: new Date(),
        type: 'system',
        metadata: {
          phase: conversation.phase,
          projectPath: conversation.projectPath,
          orchestrationMode: conversation.orchestrationMode
        }
      };

      try {
        const response = await agent.adapter.sendMessage(contextMessage);
        
        // Dynamic autonomous team assignment detection in turn 0
        if (conversation.currentTurn === 0 && conversation.orchestrationMode === 'autonomous') {
          const teamMatch = response.match(/\[EQUIPO:\s*([^\]]+)\]/i);
          if (teamMatch) {
            const requestedAgents = teamMatch[1]
              .split(/[,|\s]+/)
              .map(s => s.toLowerCase().trim())
              .filter(s => this.agents.has(s));

            if (requestedAgents.length > 0) {
              if (!requestedAgents.includes('antigravity')) requestedAgents.unshift('antigravity');
              conversation.agents = requestedAgents;
              console.log(`[Autonomous Orchestration] Antigravity seleccionó el equipo: ${conversation.agents.join(', ')}`);
            }
          }
        }

        // Detect if completion reached in review phase
        const hasApproved = response.includes('APROBADO') || response.includes('FINALIZADO') || response.includes('GOAL_REACHED') || response.includes('OBJETIVO CUMPLIDO');
        const hasPendingWork = response.includes('INCOMPLETO') || response.includes('FALTANTE') || response.includes('REQUIERE_CAMBIOS') || response.includes('CORRECCIÓN REQUERIDA') || response.includes('Próximos Pasos para OpenCode');
        const isGoalReached = conversation.phase === 'REVIEW' && hasApproved && !hasPendingWork && conversation.currentTurn >= 2;

        const sourceBackend = agent.adapter.getSourceBackend ? agent.adapter.getSourceBackend!() : agent.name;

        await this.addMessage(conversationId, agentId, response, 'agent', {
          phase: conversation.phase,
          verdict: isGoalReached ? 'GOAL_REACHED' : 'IN_PROGRESS',
          sourceBackend
        });

        if (isGoalReached) {
          this.setPhase(conversationId, 'COMPLETED');
          break;
        }
      } catch (error: any) {
        if (config.autoStopOnError) {
          throw error;
        }
        await this.addMessage(
          conversationId,
          'system',
          `⚠️ Error en agente ${agent.name}: ${error.message || error}`,
          'system'
        );
      }

      conversation.currentTurn++;
      conversation.updatedAt = new Date();
      this.saveMarkdown(conversation);

      if (config.delayBetweenTurns > 0) {
        await new Promise(resolve =>
          setTimeout(resolve, config.delayBetweenTurns)
        );
      }
    }

    conversation.status = 'completed';
    this.activeLoops.set(conversationId, false);
    this.saveMarkdown(conversation);

    this.emit('status', {
      type: 'status',
      conversationId,
      data: { status: 'completed', turns: conversation.currentTurn, phase: conversation.phase }
    } as ChatEvent);
  }

  private buildContext(
    conversation: Conversation,
    currentAgent: Agent,
    lastMessage: string
  ): string {
    const isArchitect = currentAgent.type === 'antigravity';
    const otherAgents = conversation.agents
      .map(id => this.agents.get(id))
      .filter(a => a && a.id !== currentAgent.id)
      .map(a => `${a!.name} (${a!.role})`)
      .join(', ');

    const recentMessages = conversation.messages.slice(-6).map(m => {
      const agent = this.agents.get(m.agentId);
      const sender = m.agentId === 'user' ? 'Usuario' : (agent?.name || m.agentId);
      return `### ${sender}:\n${m.content}`;
    }).join('\n\n');

    let instructions = '';
    if (isArchitect) {
      if (conversation.currentTurn === 0) {
        instructions = `Tu rol en este turno inicial es de ARQUITECTO Y LÍDER TÉCNICO. Analiza los requerimientos del usuario, define la arquitectura técnica, especifica las interfaces y entrega un plan de tareas claro para los agentes asignados (${otherAgents}).`;
      } else {
        instructions = `Tu rol en este turno es de REVISOR Y ARQUITECTO. Evalúa el código, ejecuciones de terminal, diffs y resultados presentados por el equipo. Si la solución está completa y validada, incluye la palabra 'APROBADO' en tu veredicto. Si faltan ajustes, indica 'REQUIERE_CAMBIOS' o 'INCOMPLETO' con correcciones técnicas concretas.`;
      }
    } else if (currentAgent.type === 'opencode') {
      instructions = `Tu rol es de DESARROLLADOR PRINCIPAL (OpenCode). Toma las especificaciones del Arquitecto, implementa el código funcional completo y bien estructurado, y detalla los módulos creados.`;
    } else if (currentAgent.type === 'interpreter') {
      instructions = `Tu rol es de OPEN INTERPRETER (Ejecutor de Código y QA). Ejecuta las pruebas en terminal, valida que el código no tenga errores de sintaxis ni de ejecución en el workspace y reporta los resultados de salida.`;
    } else if (currentAgent.type === 'aider') {
      instructions = `Tu rol es de AIDER (Git Master y Control de Versiones). Inspecciona el estado del repositorio Git, verifica diffs y confirma que los cambios estén listos para commit.`;
    }

    return `# Contexto del Proyecto y Colaboración
- Proyecto: ${conversation.title}
- Directorio de Trabajo: ${conversation.projectPath || 'Local Workspace'}
- Modo de Orquestación: ${conversation.orchestrationMode}
- Fase Actual: ${conversation.phase}
- Turno: ${conversation.currentTurn + 1} de ${conversation.maxTurns}
- Equipo de trabajo activo: ${conversation.agents.map(id => this.agents.get(id)?.name || id).join(', ')}

## Instrucción de Rol:
${instructions}

## Historial Reciente:
${recentMessages}

Por favor responde a continuación manteniendo tu rol y formato Markdown estructurado.`;
  }

  private saveMarkdown(conversation: Conversation): void {
    try {
      const safeProjectName = (conversation.projectPath ? conversation.projectPath.split(/[/\\]/).pop() : 'General') || 'General';
      const cleanProjectFolder = safeProjectName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const projectDir = join(this.historyDir, cleanProjectFolder);

      if (!existsSync(projectDir)) {
        mkdirSync(projectDir, { recursive: true });
      }

      const dateStr = new Date(conversation.createdAt).toISOString().split('T')[0];
      const cleanTitle = conversation.title.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 35);
      const filePath = join(projectDir, `${dateStr}_${cleanTitle}.md`);

      let md = `# Sesión Colaborativa: ${conversation.title}\n\n`;
      md += `- **ID Sesión:** \`${conversation.id}\`\n`;
      md += `- **Workspace:** \`${conversation.projectPath || 'Local'}\`\n`;
      md += `- **Modo de Orquestación:** \`${conversation.orchestrationMode}\`\n`;
      md += `- **Equipo Participante:** ${conversation.agents.map(id => this.agents.get(id)?.name || id).join(', ')}\n`;
      md += `- **Estado:** \`${conversation.status}\` | **Fase:** \`${conversation.phase}\`\n`;
      md += `- **Turnos:** ${conversation.currentTurn} / ${conversation.maxTurns}\n`;
      md += `- **Fecha de Inicio:** ${new Date(conversation.createdAt).toLocaleString()}\n`;
      md += `- **Última Actualización:** ${new Date(conversation.updatedAt).toLocaleString()}\n\n`;
      md += `---\n\n`;

      for (const msg of conversation.messages) {
        let senderName = '👤 Usuario';
        if (msg.agentId === 'antigravity') senderName = '🏛️ Antigravity (Arquitecto)';
        else if (msg.agentId === 'opencode') senderName = '💻 OpenCode (Desarrollador)';
        else if (msg.agentId === 'interpreter') senderName = '⚡ Open Interpreter (Ejecutor QA)';
        else if (msg.agentId === 'aider') senderName = '🐙 Aider (Git Manager)';
        else if (msg.agentId === 'system') senderName = '⚙️ Sistema';

        const backend = msg.metadata?.sourceBackend ? ` _[${msg.metadata.sourceBackend}]_` : '';

        md += `### ${senderName}${backend} _(${new Date(msg.timestamp).toLocaleTimeString()})_\n\n`;
        md += `${msg.content}\n\n`;
        md += `---\n\n`;
      }

      writeFileSync(filePath, md, 'utf-8');
    } catch (err: any) {
      console.error('[Error guardando Markdown de conversación]:', err.message);
    }
  }

  pauseLoop(conversationId: string): void {
    this.activeLoops.set(conversationId, false);
    const conversation = this.conversations.get(conversationId);
    if (conversation) {
      conversation.status = 'paused';
      this.saveMarkdown(conversation);
    }
  }

  resumeLoop(conversationId: string, config?: Partial<TurnConfig>): void {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    if (conversation.status === 'completed') {
      throw new Error('Cannot resume a completed conversation');
    }

    this.activeLoops.set(conversationId, true);
    conversation.status = 'active';
    this.saveMarkdown(conversation);

    this.runLoop(conversationId, { ...this.defaultTurnConfig, ...config })
      .catch(console.error);
  }
}
