/**
 * Server-side AI provider abstraction. Never imported from frontend code —
 * lives under apps/api only, and no provider configuration (base URL,
 * model name) is ever sent to the client; the frontend only sees a boolean
 * availability flag via GET /api/ai/status.
 */
export interface AIProvider {
  /** Sends a prompt, returns the raw text completion. Throws AIProviderError on any failure. */
  complete(prompt: string): Promise<string>;
  /** Cheap connectivity check — used to show a clear "unavailable" state before attempting generation. */
  checkAvailability(): Promise<boolean>;
}

// "context_overflow": the prompt was NOT sent because it cannot fit the
// configured context window (see ollamaProvider.ts) — never silently truncated.
export type AIProviderErrorCode = "unavailable" | "timeout" | "invalid_response" | "context_overflow";

export class AIProviderError extends Error {
  readonly code: AIProviderErrorCode;

  constructor(message: string, code: AIProviderErrorCode) {
    super(message);
    this.name = "AIProviderError";
    this.code = code;
  }
}
