/**
 * Persistencia del historial de una conversación como archivo Markdown.
 *
 * Ruta: `<historyDir>/<nombre_del_workspace>/<fecha>_<título>.md`
 *
 * Se reescribe el archivo completo en cada cambio (las conversaciones son
 * pequeñas y así el archivo siempre es consistente). Es deliberadamente
 * síncrono y tolerante a fallos: un error de disco no debe tumbar el ciclo.
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { Conversation, ConversationMessage } from '../types';
import { AGENT_CATALOG, isAgentType } from '../agents/catalog';
import { PHASE_LABELS } from './phases';
import { toSafeFileName } from '../utils/paths';
import { createLogger } from '../utils/logger';

const log = createLogger('HistoryWriter');

export class HistoryWriter {
  constructor(private readonly historyDir: string) {}

  /** Ruta del archivo `.md` de una conversación. */
  filePathFor(conversation: Conversation): string {
    const workspaceName = toSafeFileName(basename(conversation.projectPath) || 'general');
    const date = new Date(conversation.createdAt).toISOString().slice(0, 10);
    return join(this.historyDir, workspaceName, `${date}_${toSafeFileName(conversation.title)}.md`);
  }

  save(conversation: Conversation): void {
    try {
      const filePath = this.filePathFor(conversation);
      const dir = join(filePath, '..');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, renderMarkdown(conversation), 'utf-8');
    } catch (err) {
      log.error('no se pudo guardar el historial', err as Error);
    }
  }
}

export function renderMarkdown(conversation: Conversation): string {
  const teamNames = conversation.agents.map(labelFor).join(', ');
  const lines = [
    `# Sesión: ${conversation.title}`,
    ``,
    `| Campo | Valor |`,
    `|-------|-------|`,
    `| ID | \`${conversation.id}\` |`,
    `| Workspace | \`${conversation.projectPath}\` |`,
    `| Modo | ${conversation.orchestrationMode} |`,
    `| Equipo | ${teamNames} |`,
    `| Estado | ${conversation.status} · ${PHASE_LABELS[conversation.phase]} |`,
    `| Turnos | ${conversation.currentTurn} / ${conversation.maxTurns} |`,
    `| Inicio | ${formatDate(conversation.createdAt)} |`,
    `| Última actualización | ${formatDate(conversation.updatedAt)} |`,
    ``,
    `---`,
    ``
  ];

  for (const message of conversation.messages) {
    lines.push(renderMessage(message), '', '---', '');
  }

  return lines.join('\n');
}

function renderMessage(message: ConversationMessage): string {
  const backend = message.metadata?.sourceBackend ? ` · _${message.metadata.sourceBackend}_` : '';
  const verdict = message.metadata?.verdict ? ` · **${message.metadata.verdict}**` : '';
  const header = `### ${labelFor(message.agentId)}${backend}${verdict} — ${formatTime(message.timestamp)}`;
  return `${header}\n\n${message.content}`;
}

function labelFor(agentId: string): string {
  if (agentId === 'user') return '👤 Usuario';
  if (agentId === 'system') return '⚙️ Sistema';
  if (isAgentType(agentId)) {
    const a = AGENT_CATALOG[agentId];
    return `${a.emoji} ${a.name}`;
  }
  return agentId;
}

function formatDate(date: Date): string {
  return new Date(date).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function formatTime(date: Date): string {
  return new Date(date).toISOString().slice(11, 19) + ' UTC';
}
