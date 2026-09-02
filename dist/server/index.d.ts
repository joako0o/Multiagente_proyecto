import { ServerConfig } from '../types';
export declare class AntigravityOpenCodeServer {
    private app;
    private server;
    private manager;
    private wsServer;
    private config;
    private webDir;
    constructor(config: ServerConfig);
    private setupMiddleware;
    private setupRoutes;
    private registerDefaultAgents;
    start(): Promise<void>;
    stop(): Promise<void>;
}
//# sourceMappingURL=index.d.ts.map