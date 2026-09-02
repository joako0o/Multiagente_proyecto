/**
 * Servidor WebSocket (`/ws`).
 *
 * Dos direcciones:
 *  - cliente → servidor: `ClientCommand` (crear sesión, iniciar/pausar/reanudar ciclo, enviar mensaje).
 *  - servidor → cliente: `ServerEvent` (todo lo que emite el orquestador, difundido a todos los clientes).
 *
 * Al conectar, cada cliente recibe un evento `connected` con el catálogo de
 * agentes y el resumen de conversaciones existentes.
 */
import { Server as HttpServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { ClientCommand, ServerEvent } from '../types';
import { Orchestrator } from '../core/orchestrator';
import { AgentRegistry } from '../agents/registry';

export class ChatWebSocketServer {
  private wss?: WebSocketServer;

  constructor(private readonly orchestrator: Orchestrator, private readonly registry: AgentRegistry) {
    this.orchestrator.on('event', (event: ServerEvent) => this.broadcast(event));
  }

  attach(server: HttpServer): void {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (socket) => {
      console.log('[WebSocket] cliente conectado');

      this.send(socket, {
        type: 'connected',
        data: {
          agents: this.registry.describeAll(),
          conversations: this.orchestrator.listConversations()
        }
      });

      socket.on('message', (raw) => {
        let command: ClientCommand;
        try {
          command = JSON.parse(raw.toString());
        } catch {
          this.send(socket, { type: 'error', data: { message: 'El mensaje no es JSON válido' } });
          return;
        }
        this.handle(socket, command);
      });

      socket.on('close', () => console.log('[WebSocket] cliente desconectado'));
      socket.on('error', (err) => console.warn(`[WebSocket] error de socket: ${err.message}`));
    });
  }

  close(): void {
    this.wss?.clients.forEach(client => client.terminate());
    this.wss?.close();
  }

  // ---------------------------------------------------------------------------

  private handle(socket: WebSocket, command: ClientCommand): void {
    try {
      switch (command.type) {
        case 'create_conversation': {
          const data = command.data ?? {};
          const conversation = this.orchestrator.createConversation({
            title: data.title ?? 'Nueva sesión',
            agentIds: data.agentIds,
            projectPath: data.projectPath,
            orchestrationMode: data.orchestrationMode,
            maxTurns: data.maxTurns !== undefined ? Number(data.maxTurns) : undefined
          });
          // Solo al creador: el resto se enterará por los eventos del ciclo.
          this.send(socket, { type: 'conversation_created', conversationId: conversation.id, data: conversation });
          break;
        }

        case 'start_loop':
          this.orchestrator.startLoop(command.data.conversationId, command.data.initialPrompt, command.data.options);
          break;

        case 'send_message':
          this.orchestrator.addMessage(command.data.conversationId, 'user', command.data.content, 'user');
          break;

        case 'pause_loop':
          this.orchestrator.pauseLoop(command.data.conversationId);
          break;

        case 'resume_loop':
          this.orchestrator.resumeLoop(command.data.conversationId, command.data.options);
          break;

        default:
          this.send(socket, { type: 'error', data: { message: `Comando no reconocido: ${(command as { type?: string }).type}` } });
      }
    } catch (err) {
      const conversationId = 'data' in command && command.data && 'conversationId' in command.data
        ? command.data.conversationId
        : undefined;
      this.send(socket, { type: 'error', conversationId, data: { message: (err as Error).message } });
    }
  }

  private send(socket: WebSocket, event: ServerEvent): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(event));
    }
  }

  private broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    this.wss?.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    });
  }
}
