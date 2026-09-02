import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { ConversationManager } from '../core/conversation-manager';
import { ChatEvent } from '../types';

export class ChatWebSocketServer {
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private manager: ConversationManager;

  constructor(manager: ConversationManager) {
    this.manager = manager;
    this.setupEventForwarding();
  }

  attach(server: Server): void {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws) => {
      console.log('[WebSocket] Client connected');
      this.clients.add(ws);

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleClientMessage(ws, message);
        } catch (error) {
          ws.send(JSON.stringify({
            type: 'error',
            data: { message: 'Formato de mensaje JSON inválido' }
          }));
        }
      });

      ws.on('close', () => {
        console.log('[WebSocket] Client disconnected');
        this.clients.delete(ws);
      });

      // Send initial state to connected client
      ws.send(JSON.stringify({
        type: 'connected',
        data: {
          agents: this.manager.getAgents().map(a => ({
            id: a.id,
            name: a.name,
            role: a.role,
            type: a.type
          })),
          conversations: this.manager.getAllConversations().map(c => ({
            id: c.id,
            title: c.title,
            status: c.status,
            phase: c.phase,
            projectPath: c.projectPath,
            currentTurn: c.currentTurn,
            maxTurns: c.maxTurns
          }))
        }
      }));
    });
  }

  private setupEventForwarding(): void {
    this.manager.on('message', (event: ChatEvent) => {
      this.broadcast(event);
    });

    this.manager.on('turn_change', (event: ChatEvent) => {
      this.broadcast(event);
    });

    this.manager.on('phase_change', (event: ChatEvent) => {
      this.broadcast(event);
    });

    this.manager.on('error', (event: ChatEvent) => {
      this.broadcast(event);
    });

    this.manager.on('status', (event: ChatEvent) => {
      this.broadcast(event);
    });
  }

  private handleClientMessage(ws: WebSocket, message: any): void {
    switch (message.type) {
      case 'create_conversation':
        this.handleCreateConversation(ws, message.data);
        break;

      case 'send_message':
        this.handleSendMessage(ws, message.data);
        break;

      case 'start_loop':
        this.handleStartLoop(ws, message.data);
        break;

      case 'pause_loop':
        this.handlePauseLoop(ws, message.data);
        break;

      case 'resume_loop':
        this.handleResumeLoop(ws, message.data);
        break;

      default:
        ws.send(JSON.stringify({
          type: 'error',
          data: { message: `Tipo de mensaje no reconocido: ${message.type}` }
        }));
    }
  }

  private handleCreateConversation(ws: WebSocket, data: any): void {
    try {
      const conversation = this.manager.createConversation(
        data.title || 'Nueva Tarea',
        data.agentIds || ['antigravity', 'opencode'],
        data.projectPath,
        data.orchestrationMode || 'manual',
        data.maxTurns ? parseInt(data.maxTurns) : undefined
      );
      ws.send(JSON.stringify({
        type: 'conversation_created',
        data: conversation
      }));
    } catch (error: any) {
      ws.send(JSON.stringify({
        type: 'error',
        data: { message: error.message }
      }));
    }
  }

  private async handleSendMessage(ws: WebSocket, data: any): Promise<void> {
    try {
      await this.manager.addMessage(
        data.conversationId,
        data.agentId || 'user',
        data.content,
        'user',
        data.metadata
      );
    } catch (error: any) {
      ws.send(JSON.stringify({
        type: 'error',
        data: { message: error.message }
      }));
    }
  }

  private async handleStartLoop(ws: WebSocket, data: any): Promise<void> {
    try {
      await this.manager.startLoop(
        data.conversationId,
        data.initialPrompt,
        data.config
      );
    } catch (error: any) {
      ws.send(JSON.stringify({
        type: 'error',
        data: { message: error.message }
      }));
    }
  }

  private handlePauseLoop(ws: WebSocket, data: any): void {
    try {
      this.manager.pauseLoop(data.conversationId);
    } catch (error: any) {
      ws.send(JSON.stringify({
        type: 'error',
        data: { message: error.message }
      }));
    }
  }

  private handleResumeLoop(ws: WebSocket, data: any): void {
    try {
      this.manager.resumeLoop(data.conversationId, data.config);
    } catch (error: any) {
      ws.send(JSON.stringify({
        type: 'error',
        data: { message: error.message }
      }));
    }
  }

  broadcast(event: ChatEvent): void {
    const message = JSON.stringify(event);
    this.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }
}
