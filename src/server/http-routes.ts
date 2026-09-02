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

export function createHttpRoutes(orchestrator: Orchestrator, registry: AgentRegistry, version: string): Router {
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

  return router;
}
