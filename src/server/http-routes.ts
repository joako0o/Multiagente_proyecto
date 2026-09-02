/**
 * Rutas HTTP (REST) de solo lectura.
 *
 * Las acciones (crear sesión, iniciar ciclo…) van por WebSocket porque
 * necesitan respuesta en tiempo real; aquí solo hay consultas.
 */
import { Router } from 'express';
import { Orchestrator } from '../core/orchestrator';
import { AgentRegistry } from '../agents/registry';
import { PHASE_LABELS } from '../core/phases';
import { SkillCoordinator } from '../skills/skill-coordinator';
import { SkillLibrary } from '../skills/skill-library';
import { listWorkspace, resolveWorkspaceFile, WorkspaceAccessError } from '../core/workspace-files';

export interface HttpRouteDeps {
  orchestrator: Orchestrator;
  registry: AgentRegistry;
  skills: SkillCoordinator;
  /** Biblioteca real (para sincronizar); ausente si las skills están desactivadas. */
  skillLibrary?: SkillLibrary;
  version: string;
}

export function createHttpRoutes({ orchestrator, registry, skills, skillLibrary, version }: HttpRouteDeps): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      version,
      timestamp: new Date().toISOString(),
      conversations: orchestrator.listConversations().length
    });
  });

  /** Metadatos de los agentes (nombre, rol, emoji). */
  router.get('/agents', (_req, res) => {
    res.json(registry.describeAll());
  });

  /** Disponibilidad real de cada agente (consulta a cada adaptador). */
  router.get('/agents/status', async (_req, res) => {
    const statuses = await Promise.all(
      registry.all().map(async agent => ({
        id: agent.id,
        name: agent.name,
        backend: agent.adapter.getSourceBackend(),
        ...(await agent.adapter.getStatus())
      }))
    );
    res.json(statuses);
  });

  router.get('/phases', (_req, res) => {
    res.json(PHASE_LABELS);
  });

  /**
   * Catálogo de skills disponibles para asignar a los agentes.
   * Con `?q=texto` devuelve además `ranking`: las más relevantes para ese texto
   * (mismo criterio que usa el arquitecto en planificación).
   */
  router.get('/skills', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    res.json({
      enabled: skills.enabled,
      sources: skillLibrary?.configuredSources ?? [],
      skills: skills.summaries(),
      ...(q ? { ranking: skills.search(q, 20) } : {})
    });
  });

  /** Cuerpo (instrucciones) de una skill, para previsualizarla en el panel. */
  router.get('/skills/:name', (req, res) => {
    const info = skillLibrary?.get(req.params.name);
    if (!info || !skillLibrary) {
      res.status(404).json({ error: 'Skill no encontrada' });
      return;
    }
    res.json({ ...info, body: skillLibrary.readBody(info.name) });
  });

  /**
   * Vuelve a clonar/actualizar los repositorios de skills. Es la única ruta
   * que modifica estado, porque afecta a la caché en disco y no a una conversación.
   */
  router.post('/skills/sync', async (_req, res) => {
    if (!skillLibrary) {
      res.status(409).json({ error: 'Las skills están desactivadas (SKILLS_ENABLED=false)' });
      return;
    }
    const results = await skillLibrary.sync();
    res.json({ results, skills: skills.summaries() });
  });

  router.get('/conversations', (_req, res) => {
    res.json(orchestrator.listConversations());
  });

  router.get('/conversations/:id', (req, res) => {
    const conversation = orchestrator.getConversation(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: 'Conversación no encontrada' });
      return;
    }
    res.json(conversation);
  });

  /**
   * Archivos del workspace de una sesión (solo lectura), para ver en el panel lo
   * que producen los agentes: informes, gráficos, datos.
   *   GET /conversations/:id/files?dir=sub/carpeta   → listado
   *   GET /conversations/:id/files/raw?path=a/b.svg  → contenido con su MIME
   */
  router.get('/conversations/:id/files', (req, res) => {
    const conversation = orchestrator.getConversation(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: 'Conversación no encontrada' });
      return;
    }
    try {
      const dir = typeof req.query.dir === 'string' ? req.query.dir : '';
      res.json({ workspace: conversation.projectPath, dir, entries: listWorkspace(conversation.projectPath, dir) });
    } catch (err) {
      sendWorkspaceError(res, err);
    }
  });

  router.get('/conversations/:id/files/raw', (req, res) => {
    const conversation = orchestrator.getConversation(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: 'Conversación no encontrada' });
      return;
    }
    try {
      const file = resolveWorkspaceFile(conversation.projectPath, String(req.query.path ?? ''));
      res.type(file.mime);
      // El HTML generado por los agentes se sirve en un sandbox (iframe) desde el panel;
      // esta cabecera evita que scripts de ese HTML accedan al panel.
      res.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'self' 'unsafe-inline' data: blob: https:;");
      res.sendFile(file.path);
    } catch (err) {
      sendWorkspaceError(res, err);
    }
  });

  return router;
}

function sendWorkspaceError(res: import('express').Response, err: unknown): void {
  if (err instanceof WorkspaceAccessError) {
    res.status(err.status).json({ error: err.message });
  } else {
    res.status(500).json({ error: (err as Error).message });
  }
}
