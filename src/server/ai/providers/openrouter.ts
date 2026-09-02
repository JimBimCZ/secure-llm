import Anthropic from "@anthropic-ai/sdk";

import { createMessagesProvider } from "@/server/ai/providers/messages";
import type { LlmProvider } from "@/server/ai/types";
import { env } from "@/server/env";

/**
 * OpenRouter — a real, third-party AI gateway, and the provider that turns the
 * claim in CLAUDE.md §5 into something demonstrated rather than asserted.
 *
 * It matters that this file is nine lines of configuration. OpenRouter is a
 * different company, a different account, a different billing relationship and
 * a different set of models, and reaching it required no change to the prompt,
 * the request, the parsing, the citation guard, the anonymizer or the audit
 * record. That is the whole argument for the seam, and it is the same argument a
 * corporate AI Gateway would need.
 *
 * OpenRouter publishes an Anthropic-Messages-compatible endpoint alongside its
 * OpenAI-compatible one, so it rides the shared call path unchanged. The base
 * URL stops at `/api` because the SDK appends `/v1/messages` itself.
 *
 * `LLM_MODEL` here is an OPENROUTER model id (`anthropic/claude-opus-5`), not a
 * bare Anthropic one — the namespace is the gateway's, which is exactly the kind
 * of detail that belongs in a provider file and nowhere else. It need not even
 * be an Anthropic model: the live run of this path used `openai/gpt-4o-mini`,
 * an OpenAI model reached through the Anthropic SDK, and nothing above
 * `providers/` noticed.
 */
const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

export function createOpenRouterProvider(): LlmProvider {
  const client = new Anthropic({
    baseURL: OPENROUTER_BASE_URL,
    // OpenRouter accepts the vendor's own `x-api-key` header on this endpoint,
    // which is what the SDK sends for `apiKey`. Their documented example does
    // the same thing.
    apiKey: env.OPENROUTER_API_KEY ?? null,
    defaultHeaders: {
      // Identifies this app in OpenRouter's dashboard. Not a secret, and not
      // required — it just makes the usage legible on their side.
      "X-OpenRouter-Title": "personal-knowledge-base",
    },
    // The call wrapper owns the deadline and passes an AbortSignal. This is a
    // backstop, deliberately looser so the wrapper is what actually trips.
    timeout: env.LLM_TIMEOUT_MS * 2,
  });

  // Structured outputs off: a gateway is under no obligation to implement a
  // recent addition to the API it fronts. The prompt states the JSON contract
  // and zod verifies it, so the guarantee does not depend on the server helping.
  return createMessagesProvider("openrouter", client, {
    structuredOutputs: false,
  });
}
