import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { AIProviderError, type AIProvider } from "./aiProvider.js";

const AVAILABILITY_CHECK_TIMEOUT_MS = 3000;

/**
 * Upper bound on generated tokens, sent as `num_predict`. It is reserved
 * out of `OLLAMA_NUM_CTX` so the output can never push the prompt out of
 * the context window. A plan that needs more fails as truncated JSON
 * (502), which is logged as `doneReason: "length"`.
 */
export const MAX_OUTPUT_TOKENS = 4096;

/**
 * Deliberately pessimistic chars-per-token ratio for the pre-flight size
 * check. Measured with qwen2.5's own tokenizer on real planning prompts:
 * 3.72–4.13 chars/token (path-heavy text tokenizes densest). Using 3
 * overestimates, so a prompt that passes the check really does fit.
 */
const CHARS_PER_TOKEN_ESTIMATE = 3;
// Chat-template tokens Ollama wraps around the prompt (measured: 29).
const TEMPLATE_TOKEN_ALLOWANCE = 64;

export function estimatePromptTokens(prompt: string): number {
  return Math.ceil(prompt.length / CHARS_PER_TOKEN_ESTIMATE) + TEMPLATE_TOKEN_ALLOWANCE;
}

/** Largest estimated prompt that still leaves room for MAX_OUTPUT_TOKENS. */
export function maxPromptTokens(numCtx: number = env.OLLAMA_NUM_CTX): number {
  return numCtx - MAX_OUTPUT_TOKENS;
}

interface OllamaGenerateResponse {
  response?: unknown;
  done_reason?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
  load_duration?: unknown;
  total_duration?: unknown;
}

const nsToMs = (ns: unknown) => (typeof ns === "number" ? Math.round(ns / 1e6) : undefined);

/**
 * First (and, in this batch, only) AIProvider implementation: local
 * Ollama, reached over HTTP. Configuration (`OLLAMA_BASE_URL`,
 * `OLLAMA_MODEL`, `OLLAMA_NUM_CTX`, `AI_REQUEST_TIMEOUT_MS`) comes
 * entirely from env.ts.
 *
 * `num_ctx` is always sent explicitly (ADR-020): Ollama's default context
 * (4096 on the machine this was validated on) silently truncates a
 * longer prompt, keeping only its start and tail — a real grounded prompt
 * lost its requirement and file list that way. Logs carry sizes, timings,
 * and model name only — never prompt or response text.
 */
export class OllamaProvider implements AIProvider {
  async complete(prompt: string): Promise<string> {
    const numCtx = env.OLLAMA_NUM_CTX;
    const estimatedPromptTokens = estimatePromptTokens(prompt);
    const diag = { model: env.OLLAMA_MODEL, numCtx, promptChars: prompt.length, estimatedPromptTokens };

    if (estimatedPromptTokens > maxPromptTokens(numCtx)) {
      logger.warn(
        { ...diag, maxPromptTokens: maxPromptTokens(numCtx) },
        "AI prompt does not fit the configured context window; not sent",
      );
      throw new AIProviderError(
        `Prompt (~${estimatedPromptTokens} tokens) exceeds the configured context budget (${maxPromptTokens(numCtx)} tokens)`,
        "context_overflow",
      );
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), env.AI_REQUEST_TIMEOUT_MS);
    const startedAt = Date.now();

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
          options: { num_ctx: numCtx, num_predict: MAX_OUTPUT_TOKENS },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const elapsedMs = Date.now() - startedAt;
      if (err instanceof Error && err.name === "AbortError") {
        logger.warn(
          { ...diag, elapsedMs, timeoutMs: env.AI_REQUEST_TIMEOUT_MS },
          "AI provider request timed out",
        );
        throw new AIProviderError("AI provider request timed out", "timeout");
      }
      logger.warn({ ...diag, elapsedMs, err: (err as Error)?.message }, "AI provider request failed");
      throw new AIProviderError("AI provider is unavailable", "unavailable");
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!res.ok) {
      logger.warn({ ...diag, status: res.status }, "AI provider returned a non-OK status");
      throw new AIProviderError(`AI provider returned status ${res.status}`, "unavailable");
    }

    let data: OllamaGenerateResponse;
    try {
      data = (await res.json()) as OllamaGenerateResponse;
    } catch {
      throw new AIProviderError("AI provider response was not valid JSON", "invalid_response");
    }

    const promptEvalCount = typeof data.prompt_eval_count === "number" ? data.prompt_eval_count : undefined;
    const evalCount = typeof data.eval_count === "number" ? data.eval_count : undefined;
    const stats = {
      ...diag,
      elapsedMs: Date.now() - startedAt,
      promptEvalCount,
      evalCount,
      doneReason: typeof data.done_reason === "string" ? data.done_reason : undefined,
      loadMs: nsToMs(data.load_duration),
      totalMs: nsToMs(data.total_duration),
    };
    if (stats.doneReason === "length") {
      logger.warn(stats, "AI output hit the output token limit; the response is likely incomplete");
    } else if (promptEvalCount !== undefined && promptEvalCount + (evalCount ?? 0) >= numCtx) {
      // Should be unreachable given the pre-flight check; logged in case
      // the chars-per-token estimate ever proves too optimistic.
      logger.warn(
        stats,
        "AI prompt + output filled the context window; earlier context may have been dropped",
      );
    } else {
      logger.info(stats, "AI provider completed");
    }

    const response = data.response;
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
