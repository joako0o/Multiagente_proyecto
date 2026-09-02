import { AgentAdapter, ConversationMessage } from '../types';
export interface AntigravityConfig {
    apiKey?: string;
    model?: string;
}
export declare class AntigravityAdapter implements AgentAdapter {
    private apiKey;
    private model;
    constructor(config?: AntigravityConfig);
    getSourceBackend(): string;
    isAvailable(): Promise<boolean>;
    sendMessage(message: ConversationMessage): Promise<string>;
}
//# sourceMappingURL=antigravity.d.ts.map