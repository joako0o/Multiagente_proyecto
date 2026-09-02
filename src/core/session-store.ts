/**
 * Persistencia de sesiones entre reinicios del servidor.
 *
 * Cada conversación se guarda como `<dir>/<id>.json` (escritura atómica:
 * archivo temporal + rename). Al arrancar, `loadAll()` las recupera y marca
 * como `paused` las que estaban `active`, porque el ciclo que las ejecutaba
 * murió con el proceso; el usuario puede reanudarlas desde el panel.
 *
 * Es deliberadamente simple (un archivo por sesión, sin base de datos): las
 * sesiones son pocas y pequeñas, y así se pueden inspeccionar y borrar a mano.
 * El historial legible sigue siendo el `.md` que escribe `HistoryWriter`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Conversation, ConversationMessage } from '../types';

export class SessionStore {
  constructor(private readonly dir: string) {}

  save(conversation: Conversation): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const target = join(this.dir, `${conversation.id}.json`);
      const temp = `${target}.tmp`;
      writeFileSync(temp, JSON.stringify(conversation, null, 2), 'utf-8');
      renameSync(temp, target);
    } catch (err) {
      console.error(`[SessionStore] no se pudo guardar la sesión ${conversation.id}: ${(err as Error).message}`);
    }
  }

  delete(id: string): void {
    rmSync(join(this.dir, `${id}.json`), { force: true });
  }

  /**
   * Carga todas las sesiones guardadas. Los archivos corruptos se omiten con un
   * aviso. Las sesiones que estaban en ejecución vuelven como `paused` con un
   * mensaje de sistema que lo explica.
   */
  loadAll(): Conversation[] {
    if (!existsSync(this.dir)) return [];
    const conversations: Conversation[] = [];

    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.json')) continue;
      const path = join(this.dir, file);
      try {
        const conversation = reviveConversation(JSON.parse(readFileSync(path, 'utf-8')));
        if (conversation.status === 'active') {
          conversation.status = 'paused';
          conversation.messages.push(systemMessage(conversation.id, '⏸️ El servidor se reinició mientras el ciclo estaba en marcha. La sesión quedó en pausa; puedes reanudarla.'));
        }
        conversations.push(conversation);
      } catch (err) {
        console.warn(`[SessionStore] se omite ${file}: ${(err as Error).message}`);
      }
    }

    return conversations.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
}

/** Reconstruye los `Date` (JSON los serializa como texto) y rellena campos añadidos en versiones posteriores. */
export function reviveConversation(raw: unknown): Conversation {
  if (!raw || typeof raw !== 'object') throw new Error('contenido no es un objeto');
  const data = raw as Record<string, unknown>;
  if (typeof data.id !== 'string' || !Array.isArray(data.messages) || !Array.isArray(data.agents)) {
    throw new Error('faltan campos obligatorios (id, agents, messages)');
  }

  return {
    id: data.id,
    title: String(data.title ?? 'Sesión sin título'),
    agents: data.agents.map(String),
    messages: (data.messages as Array<Record<string, unknown>>).map(m => ({
      ...(m as unknown as ConversationMessage),
      timestamp: new Date(String(m.timestamp))
    })),
    status: (data.status as Conversation['status']) ?? 'paused',
    phase: (data.phase as Conversation['phase']) ?? 'PLANNING',
    orchestrationMode: (data.orchestrationMode as Conversation['orchestrationMode']) ?? 'manual',
    projectPath: String(data.projectPath ?? process.cwd()),
    currentTurn: Number(data.currentTurn ?? 0),
    maxTurns: Number(data.maxTurns ?? 15),
    skills: (data.skills as Record<string, string[]>) ?? {},
    nextAgentId: typeof data.nextAgentId === 'string' ? data.nextAgentId : undefined,
    createdAt: new Date(String(data.createdAt ?? Date.now())),
    updatedAt: new Date(String(data.updatedAt ?? data.createdAt ?? Date.now()))
  };
}

function systemMessage(conversationId: string, content: string): ConversationMessage {
  return {
    id: `restore-${Date.now()}`,
    conversationId,
    agentId: 'system',
    role: 'system',
    content,
    timestamp: new Date()
  };
}
