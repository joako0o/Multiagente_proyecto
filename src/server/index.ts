/**
 * Servidor de la aplicación: Express (estáticos + API REST) + WebSocket.
 *
 * Composición de dependencias:
 *   AppConfig → AgentRegistry → Orchestrator → { HTTP routes, WebSocket }
 */
import express from 'express';
import { createServer, Server as HttpServer } from 'http';
import { existsSync } from 'fs';
import { join } from 'path';
import { AppConfig } from '../config';
import { createAgentRegistry } from '../agents/registry';
import { Orchestrator } from '../core/orchestrator';
import { HistoryWriter } from '../core/history-writer';
import { createHttpRoutes } from './http-routes';
import { ChatWebSocketServer } from './websocket-server';

export const APP_VERSION = '3.0.0';

export class BridgeServer {
  private readonly app = express();
  private readonly httpServer: HttpServer;
  private readonly wsServer: ChatWebSocketServer;
  readonly orchestrator: Orchestrator;

  constructor(private readonly config: AppConfig) {
    const registry = createAgentRegistry(config);
    this.orchestrator = new Orchestrator(
      registry,
      new HistoryWriter(config.historyDir),
      { maxTurns: config.loop.maxTurns, delayBetweenTurnsMs: config.loop.delayBetweenTurnsMs, autoStopOnError: false }
    );

    this.app.use(express.json({ limit: '1mb' }));
    this.app.use('/api', createHttpRoutes(this.orchestrator, registry, APP_VERSION));
    this.app.use('/vendor', createVendorRoutes());
    this.app.use(express.static(resolveWebDir()));

    this.httpServer = createServer(this.app);
    this.wsServer = new ChatWebSocketServer(this.orchestrator, registry);
    this.wsServer.attach(this.httpServer);
  }

  start(): Promise<void> {
    const { host, port } = this.config.server;
    return new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(port, host, () => {
        printBanner(this.config);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    this.wsServer.close();
    return new Promise(resolve => this.httpServer.close(() => resolve()));
  }
}

/** Localiza `web/` tanto en desarrollo (`src/web`) como compilado (`dist/web`). */
function resolveWebDir(): string {
  const candidates = [
    join(__dirname, '..', 'web'),
    join(process.cwd(), 'dist', 'web'),
    join(process.cwd(), 'src', 'web')
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

/**
 * Sirve las librerías del panel (marked, DOMPurify, highlight.js) directamente
 * desde `node_modules`, para que funcione tanto con `npm run dev` como
 * compilado, y sin necesidad de internet.
 */
function createVendorRoutes(): express.Router {
  const router = express.Router();
  const modules = join(process.cwd(), 'node_modules');
  const files: Record<string, string> = {
    'marked.min.js': join(modules, 'marked', 'marked.min.js'),
    'purify.min.js': join(modules, 'dompurify', 'dist', 'purify.min.js'),
    'highlight.min.js': join(modules, '@highlightjs', 'cdn-assets', 'highlight.min.js'),
    'atom-one-dark.min.css': join(modules, '@highlightjs', 'cdn-assets', 'styles', 'atom-one-dark.min.css')
  };
  for (const [name, file] of Object.entries(files)) {
    router.get(`/${name}`, (_req, res) => res.sendFile(file));
  }
  return router;
}

function printBanner(config: AppConfig): void {
  const { host, port } = config.server;
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  console.log([
    '',
    '  Multi-Agent Bridge v' + APP_VERSION,
    '  ─────────────────────────────────────────────',
    `  Panel web      http://${displayHost}:${port}`,
    `  WebSocket      ws://${displayHost}:${port}/ws`,
    `  Estado agentes http://${displayHost}:${port}/api/agents/status`,
    `  Historial      ${config.historyDir}`,
    ''
  ].join('\n'));
}
