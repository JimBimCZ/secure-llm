import Anthropic from "@anthropic-ai/sdk";

import { createMessagesProvider } from "@/server/ai/providers/messages";
import type { LlmProvider } from "@/server/ai/types";
import { env } from "@/server/env";

/**
 * The real run: the vendor's own API, through the vendor's own SDK.
 *
 * The SDK rather than hand-rolled `fetch` because it owns the things a
 * hand-rolled client gets wrong quietly — retry policy on 429 and 5xx, typed
 * errors, and the exact request shape for a versioned API. The audit record
 * (§3) needs the token counts it returns, and guessing those would make the
 * record worse than useless.
 *
 * The key is read from the environment here and nowhere else. The SDK would
 * happily pick up ANTHROPIC_API_KEY on its own; passing it explicitly keeps
 * env.ts the one place that says where configuration comes from.
 */
export function createAnthropicProvider(): LlmProvider {
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY ?? null,
    // The call wrapper owns the deadline and passes an AbortSignal. This is a
    // backstop for the case the signal never fires, and it is deliberately
    // looser than the wrapper's timeout so the wrapper is what actually trips.
    timeout: env.LLM_TIMEOUT_MS * 2,
  });

  // The vendor's own API, so the newest features are available: let the server
  // enforce the response shape as well as our own zod check.
  return createMessagesProvider("anthropic", client, {
    structuredOutputs: true,
  });
}
