import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { AIProviderError, type AIProvider } from "./aiProvider.js";

const AVAILABILITY_CHECK_TIMEOUT_MS = 3000;

/**
 * First (and, in this batch, only) AIProvider implementation: local
 * Ollama, reached over HTTP. Configuration (`OLLAMA_BASE_URL`,
 * `OLLAMA_MODEL`, `AI_REQUEST_TIMEOUT_MS`) comes entirely from env.ts —
 * already scaffolded in Phase 1, reused here rather than duplicated.
 */
export class OllamaProvider implements AIProvider {
  async complete(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), env.AI_REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`${env.OLLAMA_BASE_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: env.OLLAMA_MODEL,
          prompt,
          stream: false,
          format: "json", // ask Ollama to constrain output to valid JSON
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        logger.warn({ model: env.OLLAMA_MODEL }, "AI provider request timed out");
        throw new AIProviderError("AI provider request timed out", "timeout");
      }
      logger.warn({ err: (err as Error)?.message }, "AI provider request failed");
      throw new AIProviderError("AI provider is unavailable", "unavailable");
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!res.ok) {
      logger.warn({ status: res.status }, "AI provider returned a non-OK status");
      throw new AIProviderError(`AI provider returned status ${res.status}`, "unavailable");
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new AIProviderError("AI provider response was not valid JSON", "invalid_response");
    }

    const response = (data as { response?: unknown }).response;
    if (typeof response !== "string" || response.length === 0) {
      throw new AIProviderError("AI provider response missing expected 'response' field", "invalid_response");
    }
    return response;
  }

  async checkAvailability(): Promise<boolean> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), AVAILABILITY_CHECK_TIMEOUT_MS);
    try {
      const res = await fetch(`${env.OLLAMA_BASE_URL}/api/version`, { signal: controller.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
