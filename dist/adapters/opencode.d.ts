import { AgentAdapter, ConversationMessage } from '../types';
export interface OpenCodeConfig {
    url?: string;
    password?: string;
    providerID?: string;
    modelID?: string;
}
export declare class OpenCodeAdapter implements AgentAdapter {
    private url;
    private password?;
    private providerID;
    private modelID;
    private sessionId;
    private serverProcess;
    constructor(config?: OpenCodeConfig);
    getSourceBackend(): string;
    isAvailable(): Promise<boolean>;
    private ensureServerRunning;
    createSession(title?: string, directory?: string): Promise<string>;
    sendMessage(message: ConversationMessage): Promise<string>;
    abort(): Promise<void>;
}
//# sourceMappingURL=opencode.d.ts.map