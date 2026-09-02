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
import { SessionStore } from '../core/session-store';
import { createHttpRoutes } from './http-routes';
import { ChatWebSocketServer } from './websocket-server';
import { SkillLibrary } from '../skills/skill-library';
import { SkillCoordinator } from '../skills/skill-coordinator';

export const APP_VERSION = '3.1.0';

export class BridgeServer {
  private readonly app = express();
  private readonly httpServer: HttpServer;
  private readonly wsServer: ChatWebSocketServer;
  private readonly skillLibrary?: SkillLibrary;
  readonly orchestrator: Orchestrator;

  constructor(private readonly config: AppConfig) {
    const registry = createAgentRegistry(config);

    this.skillLibrary = config.skills.enabled
      ? new SkillLibrary(config.skills.cacheDir, config.skills.sources, config.skills.bundledDirs)
      : undefined;
    const skills = new SkillCoordinator(this.skillLibrary);

    this.orchestrator = new Orchestrator({
      registry,
      history: new HistoryWriter(config.historyDir),
      store: new SessionStore(config.sessionsDir),
      skills,
      defaults: { maxTurns: config.loop.maxTurns, delayBetweenTurnsMs: config.loop.delayBetweenTurnsMs, autoStopOnError: false }
    });
    const restored = this.orchestrator.restore();
    if (restored) console.log(`[Sesiones] ${restored} sesión(es) recuperadas de ${config.sessionsDir}`);

    this.app.use(express.json({ limit: '1mb' }));
    this.app.use('/api', createHttpRoutes({ orchestrator: this.orchestrator, registry, skills, skillLibrary: this.skillLibrary, version: APP_VERSION }));
    this.app.use('/vendor', createVendorRoutes());
    this.app.use(express.static(resolveWebDir()));

    this.httpServer = createServer(this.app);
    this.wsServer = new ChatWebSocketServer(this.orchestrator, registry, skills);
    this.wsServer.attach(this.httpServer);
  }

  async start(): Promise<void> {
    await this.syncSkills();
    const { host, port } = this.config.server;
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(port, host, () => {
        printBanner(this.config, this.skillLibrary?.list().length ?? 0);
        resolve();
      });
    });
  }

  /** Clona/actualiza los repositorios de skills al arrancar (si está activado). Nunca impide arrancar. */
  private async syncSkills(): Promise<void> {
    if (!this.skillLibrary) return;
    if (this.config.skills.syncOnStart) {
      const results = await this.skillLibrary.sync();
      for (const r of results) {
        const status = r.ok ? r.action : `ERROR: ${r.detail}`;
        console.log(`[Skills] ${r.sourceId}: ${status}${r.detail && r.ok ? ` (${r.detail})` : ''}`);
      }
    }
    console.log(`[Skills] ${this.skillLibrary.list().length} skills disponibles en ${this.config.skills.cacheDir}`);
  }

  stop(): Promise<void> {
    this.orchestrator.shutdown();
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

function printBanner(config: AppConfig, skillCount: number): void {
  const { host, port } = config.server;
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  console.log([
    '',
    '  Multi-Agent Bridge v' + APP_VERSION,
    '  ─────────────────────────────────────────────',
    `  Panel web      http://${displayHost}:${port}`,
    `  WebSocket      ws://${displayHost}:${port}/ws`,
    `  Estado agentes http://${displayHost}:${port}/api/agents/status`,
    `  Skills         ${config.skills.enabled ? `${skillCount} disponibles · ${config.skills.sources.map(s => s.id).join(', ') || 'sin fuentes'}` : 'desactivadas'}`,
    `  Historial      ${config.historyDir}`,
    ''
  ].join('\n'));
}
