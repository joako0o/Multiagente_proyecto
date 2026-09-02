"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AntigravityOpenCodeServer = void 0;
const express_1 = __importDefault(require("express"));
const http_1 = require("http");
const path_1 = require("path");
const fs_1 = require("fs");
const conversation_manager_1 = require("../core/conversation-manager");
const websocket_server_1 = require("./websocket-server");
const opencode_1 = require("../adapters/opencode");
const antigravity_1 = require("../adapters/antigravity");
const interpreter_1 = require("../adapters/interpreter");
const aider_1 = require("../adapters/aider");
class AntigravityOpenCodeServer {
    constructor(config) {
        this.config = config;
        this.app = (0, express_1.default)();
        this.server = (0, http_1.createServer)(this.app);
        this.manager = new conversation_manager_1.ConversationManager();
        this.wsServer = new websocket_server_1.ChatWebSocketServer(this.manager);
        // Resolve static web directory for both src/ and dist/
        const possibleWebDirs = [
            (0, path_1.join)(__dirname, '..', 'web'),
            (0, path_1.join)(__dirname, '..', '..', 'src', 'web'),
            (0, path_1.join)(process.cwd(), 'src', 'web'),
            (0, path_1.join)(process.cwd(), 'dist', 'web')
        ];
        this.webDir = possibleWebDirs.find(d => (0, fs_1.existsSync)(d)) || possibleWebDirs[0];
        this.setupMiddleware();
        this.setupRoutes();
        this.registerDefaultAgents();
    }
    setupMiddleware() {
        this.app.use(express_1.default.json());
        this.app.use(express_1.default.static(this.webDir));
    }
    setupRoutes() {
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
            const statusList = await Promise.all(agents.map(async (a) => ({
                id: a.id,
                name: a.name,
                type: a.type,
                available: await a.adapter.isAvailable()
            })));
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
            res.sendFile((0, path_1.join)(this.webDir, 'index.html'));
        });
    }
    registerDefaultAgents() {
        const opencodeAdapter = new opencode_1.OpenCodeAdapter({
            url: this.config.opencode.url,
            password: this.config.opencode.password
        });
        const opencodeAgent = {
            id: 'opencode',
            name: 'OpenCode Desktop',
            role: 'Desarrollador / Core - Implementa código funcional y modular en terminal/IDE',
            type: 'opencode',
            adapter: opencodeAdapter
        };
        const antigravityAdapter = new antigravity_1.AntigravityAdapter({
            apiKey: this.config.antigravity.apiKey
        });
        const antigravityAgent = {
            id: 'antigravity',
            name: 'Google Antigravity',
            role: 'Arquitecto / Líder Técnico - Diseña arquitectura, asigna roles y revisa código',
            type: 'antigravity',
            adapter: antigravityAdapter
        };
        const interpreterAdapter = new interpreter_1.InterpreterAdapter();
        const interpreterAgent = {
            id: 'interpreter',
            name: 'Open Interpreter',
            role: 'Ejecutor de Entorno / QA - Corre scripts, ejecuta pruebas en terminal y valida salidas',
            type: 'interpreter',
            adapter: interpreterAdapter
        };
        const aiderAdapter = new aider_1.AiderAdapter();
        const aiderAgent = {
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
    async start() {
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
    async stop() {
        return new Promise((resolve) => {
            this.server.close(() => {
                console.log('Servidor detenido');
                resolve();
            });
        });
    }
}
exports.AntigravityOpenCodeServer = AntigravityOpenCodeServer;
//# sourceMappingURL=index.js.map