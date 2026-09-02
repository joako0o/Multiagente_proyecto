"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AntigravityAdapter = void 0;
class AntigravityAdapter {
    constructor(config) {
        this.apiKey = config?.apiKey || process.env.GEMINI_API_KEY || '';
        this.model = config?.model || process.env.ANTIGRAVITY_MODEL || 'gemini-2.5-flash';
    }
    getSourceBackend() {
        return `Google Antigravity Cloud (DeepMind Gemini • ${this.model})`;
    }
    async isAvailable() {
        return !!this.apiKey;
    }
    async sendMessage(message) {
        if (!this.apiKey) {
            return '⚠️ [Error: GEMINI_API_KEY no configurada en .env para Antigravity]';
        }
        const isAutonomous = message.metadata?.orchestrationMode === 'autonomous';
        const systemInstruction = `Eres Google Antigravity, un agente arquitecto de software y planificador de élite de Google DeepMind.
Tu misión es liderar el proyecto técnico, diseñar la arquitectura, asignar roles a los agentes especializados y revisar exhaustivamente la calidad de todo el código.

${isAutonomous ? `
MODO AUTÓNOMO ACTIVADO:
En tu primer turno, analiza los requerimientos del usuario y define la composición del equipo seleccionando los agentes que participarán:
- OpenCode: para desarrollo e implementación de código.
- Open Interpreter: para ejecución en terminal y validación de pruebas en vivo.
- Aider: para control de versiones y verificación de Git.
Al inicio de tu mensaje de planificación inicial, incluye una etiqueta estructurada con el equipo elegido:
[EQUIPO: antigravity, opencode, interpreter, aider] (o los que consideres necesarios).
` : ''}

DIRECTIVAS GENERALES:
- Responde siempre en español claro, profesional y estructurado.
- Utiliza formato Markdown con títulos, listas de verificación y bloques de código.
- En la fase de PLANIFICACIÓN: analiza los requerimientos, define la arquitectura y asigna tareas claras.
- En la fase de REVISIÓN: revisa exhaustivamente el código y las pruebas entregadas. Si el objetivo está completamente cumplido y probado, incluye la palabra 'APROBADO' en tu veredicto final; si faltan cosas, indica 'REQUIERE_CAMBIOS' o 'INCOMPLETO' con correcciones concretas.`;
        const maxRetries = 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        system_instruction: { parts: [{ text: systemInstruction }] },
                        contents: [{ role: 'user', parts: [{ text: message.content }] }],
                        generationConfig: { temperature: 0.4, maxOutputTokens: 5000 }
                    }),
                    signal: AbortSignal.timeout(45000)
                });
                if (response.status === 503 || response.status === 429) {
                    if (attempt < maxRetries) {
                        console.warn(`[Antigravity] Reintentando petición (${attempt}/${maxRetries}) tras esperar 10s...`);
                        await new Promise(r => setTimeout(r, 10000));
                        continue;
                    }
                    else {
                        return `⏳ **[Google Antigravity - Límite de Cuota]**: Se alcanzó temporalmente el límite de peticiones por minuto en Gemini Cloud (Free Tier). Esperando el siguiente turno para reanudar.`;
                    }
                }
                if (!response.ok) {
                    const errBody = await response.text();
                    return `⚠️ **[Google Antigravity Error]**: HTTP ${response.status} - ${errBody.substring(0, 100)}`;
                }
                const data = await response.json();
                const parts = data.candidates?.[0]?.content?.parts || [];
                const contentPart = parts.find((p) => p.text && !p.thought) || parts[0];
                if (contentPart?.text) {
                    return contentPart.text;
                }
            }
            catch (err) {
                console.warn(`[Antigravity] Intento ${attempt} falló:`, err.message);
                if (attempt === maxRetries) {
                    return `⚠️ Error al consultar Antigravity AI: ${err.message}`;
                }
                await new Promise(r => setTimeout(r, 2000));
            }
        }
        return '⚠️ [Antigravity: No se pudo obtener respuesta del modelo tras reintentos]';
    }
}
exports.AntigravityAdapter = AntigravityAdapter;
//# sourceMappingURL=antigravity.js.map