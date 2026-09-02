import { AgentAdapter, ConversationMessage } from '../types';
export declare class AiderAdapter implements AgentAdapter {
    getSourceBackend(): string;
    isAvailable(): Promise<boolean>;
    sendMessage(message: ConversationMessage): Promise<string>;
}
//# sourceMappingURL=aider.d.ts.map