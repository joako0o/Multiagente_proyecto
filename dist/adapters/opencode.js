"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenCodeAdapter = void 0;
const child_process_1 = require("child_process");
class OpenCodeAdapter {
    constructor(config) {
        this.sessionId = null;
        this.serverProcess = null;
        this.url = config?.url || process.env.OPENCODE_URL || 'http://127.0.0.1:4096';
        this.password = config?.password || process.env.OPENCODE_PASSWORD;
        this.providerID = config?.providerID || 'google';
        this.modelID = config?.modelID || 'gemini-2.5-flash';
    }
    getSourceBackend() {
        return `OpenCode Desktop Server (Local Port 4096 • ${this.providerID}/${this.modelID})`;
    }
    async isAvailable() {
        try {
            const response = await fetch(`${this.url}/global/health`, {
                signal: AbortSignal.timeout(1500)
            });
            return response.ok;
        }
        catch {
            return false;
        }
    }
    async ensureServerRunning() {
        if (await this.isAvailable()) {
            return true;
        }
        console.log('[OpenCode] Servidor no detectado en puerto 4096. Iniciando opencode.cmd serve...');
        try {
            this.serverProcess = (0, child_process_1.spawn)('cmd.exe', ['/c', 'opencode.cmd', 'serve', '--port', '4096'], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            });
            this.serverProcess.unref();
            // Sondeo de salud hasta 10 intentos (3 segundos)
            for (let i = 0; i < 15; i++) {
                await new Promise(r => setTimeout(r, 250));
                if (await this.isAvailable()) {
                    console.log('[OpenCode] ✅ Servidor OpenCode Desktop iniciado y conectado.');
                    return true;
                }
            }
        }
        catch (err) {
            console.warn('[OpenCode] No se pudo auto-iniciar opencode serve:', err.message);
        }
        return await this.isAvailable();
    }
    async createSession(title, directory) {
        const isLive = await this.ensureServerRunning();
        if (!isLive) {
            throw new Error('Servidor de OpenCode no disponible en ' + this.url);
        }
        const response = await fetch(`${this.url}/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: title || 'Sesión Colaborativa Antigravity',
                directory: directory || undefined
            })
        });
        if (!response.ok) {
            throw new Error(`OpenCode createSession error: HTTP ${response.status}`);
        }
        const sessionData = await response.json();
        this.sessionId = sessionData.id;
        return sessionData.id;
    }
    async sendMessage(message) {
        const maxRetries = 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const isLive = await this.ensureServerRunning();
                if (!isLive) {
                    throw new Error('No se pudo establecer conexión con OpenCode Desktop en ' + this.url);
                }
                if (!this.sessionId) {
                    await this.createSession('Colaboración: ' + (message.metadata?.projectPath || 'General'), message.metadata?.projectPath);
                }
                // Llamada a la API nativa de OpenCode OpenAPI
                const response = await fetch(`${this.url}/session/${this.sessionId}/message`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: {
                            providerID: this.providerID,
                            modelID: this.modelID
                        },
                        parts: [
                            {
                                type: 'text',
                                text: message.content
                            }
                        ]
                    }),
                    signal: AbortSignal.timeout(90000)
                });
                if (response.status === 404) {
                    // Sesión caducada, recrear y reintentar
                    this.sessionId = null;
                    if (attempt < maxRetries)
                        continue;
                }
                if (!response.ok) {
                    const errText = await response.text();
                    throw new Error(`OpenCode Server HTTP ${response.status}: ${errText}`);
                }
                const data = await response.json();
                // Handle API errors from provider in OpenCode Desktop
                if (data.info?.error || data.error) {
                    const apiErr = data.info?.error || data.error;
                    const isRateLimit = apiErr.data?.statusCode === 429 || apiErr.name === 'APIError';
                    console.warn(`[OpenCode Desktop] Error de proveedor (${apiErr.name}):`, apiErr.data?.message || apiErr.message);
                    if (isRateLimit && attempt < maxRetries) {
                        console.warn(`[OpenCode Desktop] Rate limit 429 detectado. Esperando 10s antes de reintentar (${attempt}/${maxRetries})...`);
                        await new Promise(r => setTimeout(r, 10000));
                        continue;
                    }
                    if (isRateLimit) {
                        return `⏳ **[OpenCode Desktop - Límite de Cuota]**: Se alcanzó temporalmente el límite de peticiones por minuto de Gemini API (Free Tier). Esperando siguiente turno para continuar.`;
                    }
                    return `⚠️ **[OpenCode Desktop Error]**: ${apiErr.data?.message || apiErr.message || 'Error en proveedor de IA'}`;
                }
                const parts = data.parts || [];
                // Extraer todo el texto de los bloques devueltos por OpenCode Desktop
                const textParts = parts.filter((p) => p.type === 'text' && p.text).map((p) => p.text);
                if (textParts.length > 0) {
                    return textParts.join('\n\n');
                }
                if (data.info?.finish === 'stop') {
                    return '[OpenCode Desktop completó la tarea sin salida de texto adicional]';
                }
                return '[OpenCode Desktop ejecutó la directiva]';
            }
            catch (err) {
                console.warn(`[OpenCode] Intento ${attempt}/${maxRetries} falló:`, err.message);
                if (attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, 2000 * attempt));
                }
                else {
                    return `⚠️ Error en OpenCode Desktop: ${err.message}`;
                }
            }
        }
        return '⚠️ [OpenCode Desktop: No se obtuvo respuesta tras múltiples reintentos]';
    }
    async abort() {
        if (!this.sessionId)
            return;
        try {
            await fetch(`${this.url}/session/${this.sessionId}/abort`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
        }
        catch {
            // Ignorado
        }
    }
}
exports.OpenCodeAdapter = OpenCodeAdapter;
//# sourceMappingURL=opencode.js.map