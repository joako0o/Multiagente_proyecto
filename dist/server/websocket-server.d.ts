import { Server } from 'http';
import { ConversationManager } from '../core/conversation-manager';
import { ChatEvent } from '../types';
export declare class ChatWebSocketServer {
    private wss;
    private clients;
    private manager;
    constructor(manager: ConversationManager);
    attach(server: Server): void;
    private setupEventForwarding;
    private handleClientMessage;
    private handleCreateConversation;
    private handleSendMessage;
    private handleStartLoop;
    private handlePauseLoop;
    private handleResumeLoop;
    broadcast(event: ChatEvent): void;
}
//# sourceMappingURL=websocket-server.d.ts.map