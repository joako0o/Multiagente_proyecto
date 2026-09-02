import { AgentAdapter, ConversationMessage } from '../types';
export declare class InterpreterAdapter implements AgentAdapter {
    getSourceBackend(): string;
    isAvailable(): Promise<boolean>;
    sendMessage(message: ConversationMessage): Promise<string>;
}
//# sourceMappingURL=interpreter.d.ts.map