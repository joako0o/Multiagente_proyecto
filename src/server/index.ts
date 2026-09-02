import express from 'express';
import { createServer } from 'http';
import { join } from 'path';
import { existsSync } from 'fs';
import { ConversationManager } from '../core/conversation-manager';
import { ChatWebSocketServer } from './websocket-server';
import { OpenCodeAdapter } from '../adapters/opencode';
import { AntigravityAdapter } from '../adapters/antigravity';
import { InterpreterAdapter } from '../adapters/interpreter';
import { AiderAdapter } from '../adapters/aider';
import { Agent, ServerConfig } from '../types';

export class AntigravityOpenCodeServer {
  private app: express.Application;
  private server: any;
  private manager: ConversationManager;
  private wsServer: ChatWebSocketServer;
  private config: ServerConfig;
  private webDir: string;

  constructor(config: ServerConfig) {
    this.config = config;
    this.app = express();
    this.server = createServer(this.app);
    this.manager = new ConversationManager();
    this.wsServer = new ChatWebSocketServer(this.manager);

    // Resolve static web directory for both src/ and dist/
    const possibleWebDirs = [
      join(__dirname, '..', 'web'),
      join(__dirname, '..', '..', 'src', 'web'),
      join(process.cwd(), 'src', 'web'),
      join(process.cwd(), 'dist', 'web')
    ];
    this.webDir = possibleWebDirs.find(d => existsSync(d)) || possibleWebDirs[0];

    this.setupMiddleware();
    this.setupRoutes();
    this.registerDefaultAgents();
  }

  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use(express.static(this.webDir));
  }

  private setupRoutes(): void {
    this.app.get('/api/health', (req, res) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '2.0.0',
        activeConversations: this.manager.getAllConversations().length
      });
    });

    this.app.get('/api/agents', (req, res) => {
      const agents = this.manager.getAgents().map(a => ({
        id: a.id,
        name: a.name,
        role: a.role,
        type: a.type
      }));
      res.json(agents);
    });

    this.app.get('/api/agents/status', async (req, res) => {
      const agents = this.manager.getAgents();
      const statusList = await Promise.all(
        agents.map(async (a) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          available: await a.adapter.isAvailable()
        }))
      );
      res.json(statusList);
    });

    this.app.get('/api/conversations', (req, res) => {
      const conversations = this.manager.getAllConversations().map(c => ({
        id: c.id,
        title: c.title,
        status: c.status,
        phase: c.phase,
        projectPath: c.projectPath,
        currentTurn: c.currentTurn,
        maxTurns: c.maxTurns,
        messageCount: c.messages.length
      }));
      res.json(conversations);
    });

    this.app.get('/api/conversations/:id', (req, res) => {
      const conversation = this.manager.getConversation(req.params.id);
      if (!conversation) {
        res.status(404).json({ error: 'Conversación no encontrada' });
        return;
      }
      res.json(conversation);
    });

    this.app.get('/', (req, res) => {
      res.sendFile(join(this.webDir, 'index.html'));
    });
  }

  private registerDefaultAgents(): void {
    const opencodeAdapter = new OpenCodeAdapter({
      url: this.config.opencode.url,
      password: this.config.opencode.password
    });

    const opencodeAgent: Agent = {
      id: 'opencode',
      name: 'OpenCode Desktop',
      role: 'Desarrollador / Core - Implementa código funcional y modular en terminal/IDE',
      type: 'opencode',
      adapter: opencodeAdapter
    };

    const antigravityAdapter = new AntigravityAdapter({
      apiKey: this.config.antigravity.apiKey
    });

    const antigravityAgent: Agent = {
      id: 'antigravity',
      name: 'Google Antigravity',
      role: 'Arquitecto / Líder Técnico - Diseña arquitectura, asigna roles y revisa código',
      type: 'antigravity',
      adapter: antigravityAdapter
    };

    const interpreterAdapter = new InterpreterAdapter();
    const interpreterAgent: Agent = {
      id: 'interpreter',
      name: 'Open Interpreter',
      role: 'Ejecutor de Entorno / QA - Corre scripts, ejecuta pruebas en terminal y valida salidas',
      type: 'interpreter',
      adapter: interpreterAdapter
    };

    const aiderAdapter = new AiderAdapter();
    const aiderAgent: Agent = {
      id: 'aider',
      name: 'Aider Git Master',
      role: 'Control de Versiones & Diffs - Gestiona ramas, verifica cambios y prepara commits',
      type: 'aider',
      adapter: aiderAdapter
    };

    this.manager.registerAgent(antigravityAgent);
    this.manager.registerAgent(opencodeAgent);
    this.manager.registerAgent(interpreterAgent);
    this.manager.registerAgent(aiderAgent);
  }

  async start(): Promise<void> {
    this.wsServer.attach(this.server);

    return new Promise((resolve) => {
      this.server.listen(this.config.port, this.config.host, () => {
        console.log(`
╔═══════════════════════════════════════════════════════════════╗
║         Antigravity ↔ OpenCode Collaboration Bridge 2.0      ║
╠═══════════════════════════════════════════════════════════════╣
║  Servidor Web/API:  http://${this.config.host}:${this.config.port}          ║
║  WebSocket Server:  ws://${this.config.host}:${this.config.port}/ws        ║
║  Target OpenCode:   ${this.config.opencode.url.padEnd(35)}║
║  Modelo Antigravity: ${(this.config.antigravity.model || 'gemini-2.5-flash').padEnd(33)}║
╚═══════════════════════════════════════════════════════════════╝
        `);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => {
        console.log('Servidor detenido');
        resolve();
      });
    });
  }
}
