/**
 * Registro de agentes: une cada entrada del catálogo con su adaptador.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  CÓMO AÑADIR UN AGENTE NUEVO                                         │
 * │  1. Añade el tipo en `AgentType` (src/types/index.ts).               │
 * │  2. Añade sus metadatos en `AGENT_CATALOG` (src/agents/catalog.ts).  │
 * │  3. Crea `src/adapters/<tipo>.ts` implementando `AgentAdapter`       │
 * │     (si es una CLI, extiende `BaseCliAdapter`).                      │
 * │  4. Añade su configuración en `src/config.ts` y `.env.example`.      │
 * │  5. Instáncialo aquí, en `createAgentRegistry`.                      │
 * └──────────────────────────────────────────────────────────────────────┘
 */
import { Agent, AgentAdapter, AgentDescriptor, AgentType } from '../types';
import { AppConfig } from '../config';
import { AGENT_CATALOG, AGENT_ORDER } from './catalog';
import { AntigravityAdapter } from '../adapters/antigravity';
import { OpenCodeAdapter } from '../adapters/opencode';
import { OpenHandsAdapter } from '../adapters/openhands';
import { AiderAdapter } from '../adapters/aider';
import { InterpreterAdapter } from '../adapters/interpreter';

export class AgentRegistry {
  private readonly agents = new Map<string, Agent>();

  register(type: AgentType, adapter: AgentAdapter): void {
    const descriptor = AGENT_CATALOG[type];
    this.agents.set(descriptor.id, { ...descriptor, adapter });
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  /** Agentes en el orden definido por el catálogo. */
  all(): Agent[] {
    return AGENT_ORDER.map(type => this.agents.get(type)).filter((a): a is Agent => Boolean(a));
  }

  /** Versión serializable (sin el adaptador) para API y WebSocket. */
  describeAll(): AgentDescriptor[] {
    return this.all().map(({ adapter: _adapter, ...descriptor }) => descriptor);
  }

  /** Nombre visible de un agente, o el id si no existe (p. ej. `user`, `system`). */
  displayName(id: string): string {
    return this.agents.get(id)?.name ?? id;
  }
}

/** Crea el registro con los cinco agentes soportados. */
export function createAgentRegistry(config: AppConfig): AgentRegistry {
  const registry = new AgentRegistry();
  registry.register('antigravity', new AntigravityAdapter(config.antigravity));
  registry.register('opencode', new OpenCodeAdapter(config.opencode));
  registry.register('openhands', new OpenHandsAdapter(config.openhands));
  registry.register('aider', new AiderAdapter(config.aider));
  registry.register('interpreter', new InterpreterAdapter(config.interpreter));
  return registry;
}
