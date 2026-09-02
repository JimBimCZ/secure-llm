import { createLocalEmbedder } from "@/server/ai/embedders/local";
import { createMockEmbedder } from "@/server/ai/embedders/mock";
import { createAnthropicProvider } from "@/server/ai/providers/anthropic";
import { createGatewayProvider } from "@/server/ai/providers/gateway";
import { createMockLlmProvider } from "@/server/ai/providers/mock";
import { createOpenRouterProvider } from "@/server/ai/providers/openrouter";
import type { EmbeddingProvider, LlmProvider } from "@/server/ai/types";
import { env } from "@/server/env";

/**
 * The only place that decides which implementation is in use. Everything else
 * takes the interface, so adding a provider is a new file plus an env value —
 * no call site changes anywhere.
 *
 * Both are cached for the life of the process: the embedder holds a loaded
 * model, and the LLM client holds a connection pool.
 */
let embedder: EmbeddingProvider | null = null;

export function getEmbedder(): EmbeddingProvider {
  if (embedder) return embedder;

  embedder =
    env.EMBEDDING_PROVIDER === "local"
      ? createLocalEmbedder()
      : createMockEmbedder();

  return embedder;
}

let llm: LlmProvider | null = null;

export function getLlmProvider(): LlmProvider {
  if (llm) return llm;

  switch (env.LLM_PROVIDER) {
    case "anthropic":
      llm = createAnthropicProvider();
      break;
    case "openrouter":
      llm = createOpenRouterProvider();
      break;
    case "gateway":
      llm = createGatewayProvider();
      break;
    default:
      llm = createMockLlmProvider();
  }

  return llm;
}
