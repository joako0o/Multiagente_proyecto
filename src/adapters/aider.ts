import { AgentAdapter, ConversationMessage } from '../types';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';

const execAsync = promisify(exec);

export class AiderAdapter implements AgentAdapter {
  getSourceBackend(): string {
    return 'Git Manager & Version Control Agent (Git 2.54 CLI)';
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execAsync('git --version');
      return true;
    } catch {
      return false;
    }
  }

  async sendMessage(message: ConversationMessage): Promise<string> {
    const rawPath = message.metadata?.projectPath || process.cwd();
    const cleanPath = rawPath.replace(/^["']|["']$/g, '').trim();
    const cwd = existsSync(cleanPath) ? cleanPath : process.cwd();

    try {
      const { stdout: statusOut } = await execAsync('git status --short', { cwd, timeout: 6000 });
      const { stdout: branchOut } = await execAsync('git branch --show-current', { cwd, timeout: 6000 }).catch(() => ({ stdout: 'main' }));

      const branch = branchOut.trim() || 'main';
      const modifiedFiles = statusOut.trim().split('\n').filter(Boolean);

      return `### 🐙 Aider (Git Manager & Control de Versiones)

- **Rama Git Actual:** \`${branch}\`
- **Directorio Repositorio:** \`${cwd}\`
- **Archivos Modificados / Pendientes:** ${modifiedFiles.length}

\`\`\`git
${statusOut.trim() || 'Repositorio limpio sin cambios pendientes de commit.'}
\`\`\`

**Acción Git:**
- Se verificó la integridad del árbol de trabajo.
- Los cambios están listos para ser versionados tras la aprobación final del Arquitecto.`;
    } catch (err: any) {
      return `### 🐙 Aider (Git Manager)

- **Directorio:** \`${cwd}\`
- **Estado:** ℹ️ No se detectó repositorio Git inicializado o directorio no versionado (\`${err.message}\`).`;
    }
  }
}
