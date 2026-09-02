import Anthropic from "@anthropic-ai/sdk";

import { createMessagesProvider } from "@/server/ai/providers/messages";
import type { LlmProvider } from "@/server/ai/types";
import { env } from "@/server/env";

/**
 * A corporate AI Gateway — the deployment most companies actually run, where
 * calls leave through an internal proxy that holds the vendor credentials, logs
 * usage per team, and enforces policy.
 *
 * This file is the evidence that the seam in CLAUDE.md §5 is real rather than
 * decorative, and what it shows is how small the swap is: a different base URL
 * and a different auth header. `Authorization: Bearer` instead of `x-api-key`,
 * because a gateway authenticates the *caller* against itself, not against the
 * vendor. Everything downstream — prompt, request, parsing, the citation guard
 * — is untouched, because it is the same `createMessagesProvider` call.
 *
 * This is the generic form, for a gateway whose base URL and credential you
 * supply. `openrouter.ts` is the same thing with the address filled in, and
 * running it exercises this exact code path against a real third-party gateway —
 * so the pattern below is demonstrated, even though this particular file is
 * configured rather than exercised. A proxy with its own wire format would be a
 * different file implementing the same interface, which is precisely the point.
 */
export function createGatewayProvider(): LlmProvider {
  if (!env.LLM_GATEWAY_BASE_URL) {
    throw new Error("LLM_PROVIDER=gateway requires LLM_GATEWAY_BASE_URL");
  }

  const client = new Anthropic({
    baseURL: env.LLM_GATEWAY_BASE_URL,
    // No vendor key: the gateway holds that. We authenticate to the gateway.
    apiKey: null,
    authToken: env.LLM_GATEWAY_API_KEY ?? null,
    timeout: env.LLM_TIMEOUT_MS * 2,
  });

  // Structured outputs off, for the same reason as openrouter.ts: a proxy need
  // not implement every feature of the API it fronts.
  return createMessagesProvider("gateway", client, {
    structuredOutputs: false,
  });
}
