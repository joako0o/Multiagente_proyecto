/**
 * Adaptador de Antigravity (agente arquitecto).
 *
 * A diferencia del resto de agentes, Antigravity no es una herramienta que
 * toque archivos: es un LLM al que se le pide planificar y revisar. Soporta
 * dos proveedores:
 *  - `gemini`: API oficial de Google (`generativelanguage.googleapis.com`).
 *  - `openai`: cualquier endpoint compatible con `/v1/chat/completions`
 *    (Ollama, LM Studio, el `antigravity_bridge.py` incluido, etc.).
 */
import { AdapterStatus, AgentAdapter, AgentTask } from '../types';
import { AppConfig } from '../config';

type AntigravityConfig = AppConfig['antigravity'];

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 10_000;

const SYSTEM_PROMPT = `Eres Antigravity, arquitecto de software y líder técnico de un equipo de agentes de IA.
Tu misión es diseñar la arquitectura, repartir el trabajo entre los agentes y revisar con rigor todo lo que entregan.

Reglas:
- Responde siempre en español, con Markdown claro (títulos, listas de tareas, bloques de código cuando aporten).
- Sé concreto: nombra archivos, funciones, comandos y criterios de aceptación.
- No inventes resultados: si un agente reporta un error, trátalo como error.
- Cuando actúes como revisor, cierra SIEMPRE con una línea de veredicto exactamente así:
  VEREDICTO: APROBADO      (si el objetivo está completo y validado)
  VEREDICTO: REQUIERE_CAMBIOS   (si falta algo; enumera qué y para quién)`;

export class AntigravityAdapter implements AgentAdapter {
  constructor(private readonly config: AntigravityConfig) {}

  getSourceBackend(): string {
    return this.config.provider === 'gemini'
      ? `Gemini API · ${this.config.model}`
      : `OpenAI-compatible (${this.config.baseUrl}) · ${this.config.model}`;
  }

  async getStatus(): Promise<AdapterStatus> {
    if (this.config.provider === 'gemini') {
      return this.config.apiKey
        ? { available: true, mode: 'gemini', detail: this.config.model }
        : { available: false, mode: 'gemini', detail: 'Falta GEMINI_API_KEY (o ANTIGRAVITY_API_KEY)' };
    }

    // Para endpoints compatibles con OpenAI probamos que respondan a /models.
    try {
      const response = await fetch(`${this.config.baseUrl}/models`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(3000)
      });
      return response.ok
        ? { available: true, mode: 'openai', detail: `${this.config.baseUrl} · ${this.config.model}` }
        : { available: false, mode: 'openai', detail: `HTTP ${response.status} en ${this.config.baseUrl}/models` };
    } catch (err) {
      return { available: false, mode: 'openai', detail: `Sin conexión con ${this.config.baseUrl}: ${(err as Error).message}` };
    }
  }

  async sendMessage(task: AgentTask): Promise<string> {
    const status = await this.getStatus();
    if (!status.available) {
      return `### 🏛️ Antigravity\n\n⚠️ **No configurado:** ${status.detail}`;
    }

    let lastError = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const text = this.config.provider === 'gemini'
          ? await this.callGemini(task.prompt)
          : await this.callOpenAiCompatible(task.prompt);
        if (text.trim()) return text.trim();
        lastError = 'respuesta vacía del modelo';
      } catch (err) {
        lastError = (err as Error).message;
        const retryable = /HTTP (429|5\d\d)|timeout|aborted|fetch failed/i.test(lastError);
        console.warn(`[Antigravity] intento ${attempt}/${MAX_ATTEMPTS} falló: ${lastError}`);
        if (!retryable) break;
      }
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS);
      }
    }

    return `### 🏛️ Antigravity\n\n⚠️ **No se pudo obtener respuesta del modelo** (${lastError}).\n\n` +
      `_Si es un límite de cuota (HTTP 429), espera unos segundos y reanuda el ciclo._`;
  }

  // ---------------------------------------------------------------------------
  // Proveedores
  // ---------------------------------------------------------------------------

  private async callGemini(prompt: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.config.model}:generateContent`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.config.apiKey },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 6000 }
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    const data = await response.json() as GeminiResponse;
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    // Los modelos "thinking" pueden devolver partes de razonamiento marcadas con `thought`.
    return parts.filter(p => p.text && !p.thought).map(p => p.text).join('\n');
  }

  private async callOpenAiCompatible(prompt: string): Promise<string> {
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({
        model: this.config.model,
        temperature: 0.3,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ]
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    const data = await response.json() as OpenAiResponse;
    return data.choices?.[0]?.message?.content ?? '';
  }

  private authHeaders(): Record<string, string> {
    return this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {};
  }
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
}

interface OpenAiResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
