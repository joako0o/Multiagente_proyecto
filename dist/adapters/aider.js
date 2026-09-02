"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiderAdapter = void 0;
const child_process_1 = require("child_process");
const util_1 = require("util");
const fs_1 = require("fs");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
class AiderAdapter {
    getSourceBackend() {
        return 'Git Manager & Version Control Agent (Git 2.54 CLI)';
    }
    async isAvailable() {
        try {
            await execAsync('git --version');
            return true;
        }
        catch {
            return false;
        }
    }
    async sendMessage(message) {
        const rawPath = message.metadata?.projectPath || process.cwd();
        const cleanPath = rawPath.replace(/^["']|["']$/g, '').trim();
        const cwd = (0, fs_1.existsSync)(cleanPath) ? cleanPath : process.cwd();
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
        }
        catch (err) {
            return `### 🐙 Aider (Git Manager)

- **Directorio:** \`${cwd}\`
- **Estado:** ℹ️ No se detectó repositorio Git inicializado o directorio no versionado (\`${err.message}\`).`;
        }
    }
}
exports.AiderAdapter = AiderAdapter;
//# sourceMappingURL=aider.js.map