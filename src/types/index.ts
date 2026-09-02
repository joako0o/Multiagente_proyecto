export type AgentType = 'antigravity' | 'opencode' | 'interpreter' | 'aider';
export type ConversationPhase = 'PLANNING' | 'DEVELOPMENT' | 'EXECUTION' | 'REVIEW' | 'COMPLETED';
export type Verdict = 'APPROVED' | 'CHANGES_REQUESTED' | 'GOAL_REACHED' | 'IN_PROGRESS';
export type OrchestrationMode = 'manual' | 'autonomous';

export interface Agent {
  id: string;
  name: string;
  role: string;
  type: AgentType;
  adapter: AgentAdapter;
}

export interface AgentAdapter {
  sendMessage(message: ConversationMessage): Promise<string>;
  isAvailable(): Promise<boolean>;
  getSourceBackend?(): string;
}

export interface MessageMetadata {
  phase?: ConversationPhase;
  verdict?: Verdict;
  projectPath?: string;
  sourceBackend?: string;
  orchestrationMode?: OrchestrationMode;
  [key: string]: any;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  agentId: string;
  content: string;
  timestamp: Date;
  type: 'user' | 'agent' | 'system';
  metadata?: MessageMetadata;
}

export interface Conversation {
  id: string;
  title: string;
  agents: string[];
  messages: ConversationMessage[];
  status: 'active' | 'paused' | 'completed';
  phase: ConversationPhase;
  orchestrationMode: OrchestrationMode;
  projectPath?: string;
  currentTurn: number;
  maxTurns: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatEvent {
  type: 'message' | 'turn_change' | 'phase_change' | 'error' | 'status';
  conversationId: string;
  data: any;
}

export interface TurnConfig {
  maxTurns: number;
  delayBetweenTurns: number;
  autoStopOnError: boolean;
  projectPath?: string;
  orchestrationMode?: OrchestrationMode;
}

export interface ServerConfig {
  port: number;
  host: string;
  opencode: {
    url: string;
    password?: string;
    apiKey?: string;
    model?: string;
  };
  antigravity: {
    apiKey?: string;
    model?: string;
  };
}
