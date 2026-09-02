import { EventEmitter } from 'events';
import { Agent, Conversation, ConversationMessage, ConversationPhase, TurnConfig, OrchestrationMode } from '../types';
export declare class ConversationManager extends EventEmitter {
    private conversations;
    private agents;
    private activeLoops;
    private historyDir;
    private defaultTurnConfig;
    constructor();
    registerAgent(agent: Agent): void;
    getAgent(id: string): Agent | undefined;
    getAgents(): Agent[];
    createConversation(title: string, agentIds: string[], projectPath?: string, orchestrationMode?: OrchestrationMode, maxTurns?: number): Conversation;
    getConversation(id: string): Conversation | undefined;
    getAllConversations(): Conversation[];
    addMessage(conversationId: string, agentId: string, content: string, type?: 'user' | 'agent' | 'system', metadata?: Record<string, any>): Promise<ConversationMessage>;
    setPhase(conversationId: string, phase: ConversationPhase): void;
    startLoop(conversationId: string, initialPrompt: string, config?: Partial<TurnConfig>): Promise<void>;
    private runLoop;
    private buildContext;
    private saveMarkdown;
    pauseLoop(conversationId: string): void;
    resumeLoop(conversationId: string, config?: Partial<TurnConfig>): void;
}
//# sourceMappingURL=conversation-manager.d.ts.map