import { OllamaProvider } from "./ollamaProvider.js";
import type { AIProvider } from "./aiProvider.js";

export type { AIProvider } from "./aiProvider.js";
export { AIProviderError } from "./aiProvider.js";

let instance: AIProvider | undefined;

/**
 * Returns the configured AIProvider (currently always Ollama — `env.AI_PROVIDER`
 * is a Zod enum of exactly `["ollama"]` today; a second implementation
 * would branch here without touching any call site). Lazily constructed
 * and cached, so plan.service.ts never imports OllamaProvider directly —
 * this is also the single seam tests replace via `vi.mock`.
 */
export function getAIProvider(): AIProvider {
  instance ??= new OllamaProvider();
  return instance;
}
