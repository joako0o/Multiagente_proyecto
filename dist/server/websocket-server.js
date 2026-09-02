"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatWebSocketServer = void 0;
const ws_1 = require("ws");
class ChatWebSocketServer {
    constructor(manager) {
        this.wss = null;
        this.clients = new Set();
        this.manager = manager;
        this.setupEventForwarding();
    }
    attach(server) {
        this.wss = new ws_1.WebSocketServer({ server, path: '/ws' });
        this.wss.on('connection', (ws) => {
            console.log('[WebSocket] Client connected');
            this.clients.add(ws);
            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    this.handleClientMessage(ws, message);
                }
                catch (error) {
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
    setupEventForwarding() {
        this.manager.on('message', (event) => {
            this.broadcast(event);
        });
        this.manager.on('turn_change', (event) => {
            this.broadcast(event);
        });
        this.manager.on('phase_change', (event) => {
            this.broadcast(event);
        });
        this.manager.on('error', (event) => {
            this.broadcast(event);
        });
        this.manager.on('status', (event) => {
            this.broadcast(event);
        });
    }
    handleClientMessage(ws, message) {
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
    handleCreateConversation(ws, data) {
        try {
            const conversation = this.manager.createConversation(data.title || 'Nueva Tarea', data.agentIds || ['antigravity', 'opencode'], data.projectPath, data.orchestrationMode || 'manual', data.maxTurns ? parseInt(data.maxTurns) : undefined);
            ws.send(JSON.stringify({
                type: 'conversation_created',
                data: conversation
            }));
        }
        catch (error) {
            ws.send(JSON.stringify({
                type: 'error',
                data: { message: error.message }
            }));
        }
    }
    async handleSendMessage(ws, data) {
        try {
            await this.manager.addMessage(data.conversationId, data.agentId || 'user', data.content, 'user', data.metadata);
        }
        catch (error) {
            ws.send(JSON.stringify({
                type: 'error',
                data: { message: error.message }
            }));
        }
    }
    async handleStartLoop(ws, data) {
        try {
            await this.manager.startLoop(data.conversationId, data.initialPrompt, data.config);
        }
        catch (error) {
            ws.send(JSON.stringify({
                type: 'error',
                data: { message: error.message }
            }));
        }
    }
    handlePauseLoop(ws, data) {
        try {
            this.manager.pauseLoop(data.conversationId);
        }
        catch (error) {
            ws.send(JSON.stringify({
                type: 'error',
                data: { message: error.message }
            }));
        }
    }
    handleResumeLoop(ws, data) {
        try {
            this.manager.resumeLoop(data.conversationId, data.config);
        }
        catch (error) {
            ws.send(JSON.stringify({
                type: 'error',
                data: { message: error.message }
            }));
        }
    }
    broadcast(event) {
        const message = JSON.stringify(event);
        this.clients.forEach((client) => {
            if (client.readyState === ws_1.WebSocket.OPEN) {
                client.send(message);
            }
        });
    }
}
exports.ChatWebSocketServer = ChatWebSocketServer;
//# sourceMappingURL=websocket-server.js.map