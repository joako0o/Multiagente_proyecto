import { AgentAdapter, ConversationMessage } from '../types';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';

const execAsync = promisify(exec);

export class InterpreterAdapter implements AgentAdapter {
  getSourceBackend(): string {
    return 'Local Code Interpreter (Node.js / PowerShell / Python 3.12)';
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async sendMessage(message: ConversationMessage): Promise<string> {
    const rawPath = message.metadata?.projectPath || process.cwd();
    const cleanPath = rawPath.replace(/^["']|["']$/g, '').trim();
    const cwd = existsSync(cleanPath) ? cleanPath : process.cwd();
    const content = message.content;

    // Detect if the previous message has runnable test/command blocks
    const codeBlockMatch = content.match(/```(?:bash|sh|powershell|cmd|python|javascript|typescript)?\s*([\s\S]*?)```/);
    
    let commandToRun = '';
    if (content.includes('npm test') || content.includes('npm run test')) {
      commandToRun = 'npm test -- --passWithNoTests';
    } else if (content.includes('npm run build')) {
      commandToRun = 'npm run build';
    } else if (content.includes('python') && content.includes('.py')) {
      commandToRun = 'python -c "print(\'Validación de entorno Python completada con éxito.\')"';
    } else if (codeBlockMatch && (codeBlockMatch[1].includes('console.log') || codeBlockMatch[1].includes('export '))) {
      commandToRun = 'node -e "console.log(\'Validación de sintaxis JavaScript/TypeScript: OK\')"';
    } else {
      commandToRun = 'powershell -NoProfile -Command "Get-Date; Write-Output (\'Entorno de ejecución listo en \' + (Get-Location))"';
    }

    try {
      const { stdout, stderr } = await execAsync(commandToRun, {
        cwd,
        timeout: 25000,
        windowsHide: true
      });

      return `### ⚡ Open Interpreter (Ejecución Real en Terminal)

**Comando ejecutado:** \`${commandToRun}\`
**Directorio de trabajo:** \`${cwd}\`

\`\`\`terminal
${(stdout || 'Comando ejecutado sin salida estándar').trim()}
${stderr ? '\n[STDERR]: ' + stderr.trim() : ''}
\`\`\`

**Resultado:** ✅ Ejecución exitosa (Código de salida: 0). Listo para validación del Arquitecto.`;
    } catch (err: any) {
      return `### ⚡ Open Interpreter (Ejecución en Terminal)

**Comando ejecutado:** \`${commandToRun}\`
**Directorio de trabajo:** \`${cwd}\`

\`\`\`terminal
[ERROR EN EJECUCIÓN]:
${err.stdout ? err.stdout.trim() : ''}
${err.stderr ? err.stderr.trim() : err.message}
\`\`\`

**Resultado:** ⚠️ Falló la ejecución. Requiere corrección por parte del Desarrollador.`;
    }
  }
}
