import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "../../../config/env.js";
import { logger } from "../../../utils/logger.js";
import { AIProviderError } from "../aiProvider.js";
import {
  MAX_OUTPUT_TOKENS,
  OllamaProvider,
  estimatePromptTokens,
  maxPromptTokens,
} from "../ollamaProvider.js";

// Unit tests of the HTTP contract with Ollama — fetch is stubbed. The real
// model is exercised separately (see docs/IMPLEMENTATION_LOG.md, C5 real
// Ollama validation).

function okResponse(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("OllamaProvider.complete", () => {
  it("always sends an explicit num_ctx and an output cap", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResponse({ response: "{}", done_reason: "stop" })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new OllamaProvider().complete("plan this")).resolves.toBe("{}");

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.options).toEqual({ num_ctx: env.OLLAMA_NUM_CTX, num_predict: MAX_OUTPUT_TOKENS });
    expect(body).toMatchObject({
      model: env.OLLAMA_MODEL,
      stream: false,
      format: "json",
      prompt: "plan this",
    });
  });

  it("refuses a prompt that cannot fit the context window — never sends it to be truncated", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tooBig = "x".repeat((maxPromptTokens() + 1) * 3);

    const err = await new OllamaProvider().complete(tooBig).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AIProviderError);
    expect((err as AIProviderError).code).toBe("context_overflow");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a prompt at the budget boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(okResponse({ response: "{}" }))),
    );
    const chars = (maxPromptTokens() - estimatePromptTokens("")) * 3;
    expect(estimatePromptTokens("x".repeat(chars))).toBe(maxPromptTokens());
    await expect(new OllamaProvider().complete("x".repeat(chars))).resolves.toBe("{}");
  });

  it("maps an aborted request to a timeout and logs diagnostics without the prompt text", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }),
      ),
    );
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    const pending = new OllamaProvider().complete("SECRET-PROMPT-TEXT").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(env.AI_REQUEST_TIMEOUT_MS);
    const err = await pending;

    expect((err as AIProviderError).code).toBe("timeout");
    const [fields, message] = warn.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(message).toMatch(/timed out/);
    expect(fields).toMatchObject({
      model: env.OLLAMA_MODEL,
      numCtx: env.OLLAMA_NUM_CTX,
      promptChars: "SECRET-PROMPT-TEXT".length,
      timeoutMs: env.AI_REQUEST_TIMEOUT_MS,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET-PROMPT-TEXT");
  });

  it("logs token counts and timings on success, and warns when output hit the limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          okResponse({
            response: '{"a":1}',
            done_reason: "length",
            prompt_eval_count: 4600,
            eval_count: MAX_OUTPUT_TOKENS,
            load_duration: 22_000_000_000,
            total_duration: 90_000_000_000,
          }),
        ),
      ),
    );
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    await new OllamaProvider().complete("p");
    const [fields, message] = warn.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(message).toMatch(/output token limit/);
    expect(fields).toMatchObject({
      promptEvalCount: 4600,
      evalCount: MAX_OUTPUT_TOKENS,
      loadMs: 22000,
      totalMs: 90000,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('{"a":1}');
  });

  it("keeps the existing error mapping for network failures and non-OK statuses", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
    );
    expect(((await new OllamaProvider().complete("p").catch((e) => e)) as AIProviderError).code).toBe(
      "unavailable",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("nope", { status: 500 }))),
    );
    expect(((await new OllamaProvider().complete("p").catch((e) => e)) as AIProviderError).code).toBe(
      "unavailable",
    );
  });
});

describe("prompt budget", () => {
  it("reserves the output budget out of the context window", () => {
    expect(maxPromptTokens(16384)).toBe(16384 - MAX_OUTPUT_TOKENS);
  });

  it("overestimates relative to the measured qwen2.5 ratio (>= 3.72 chars/token)", () => {
    // 16,989-char real grounded prompt measured at 4,565 tokens (+29 template).
    expect(estimatePromptTokens("x".repeat(16989))).toBeGreaterThan(4565 + 29);
  });
});
