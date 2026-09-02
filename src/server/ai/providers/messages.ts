import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import { renderAnswerPrompt } from "@/server/ai/prompts";
import { answerSchema, type AnswerJson } from "@/server/ai/providers/schema";
import type { AnswerInput, AnswerResult, LlmProvider } from "@/server/ai/types";
import { env } from "@/server/env";

/**
 * One Messages API call, shared by every provider that speaks the Anthropic
 * wire format — the vendor directly, and any gateway that fronts it.
 *
 * It lives in its own file to make the point `gateway.ts` and `openrouter.ts`
 * exist to make: the entire difference between calling the vendor and calling a
 * gateway is how the client is constructed. Nothing about the request, the
 * prompt, or the parsing changes. If that were not true, the abstraction in
 * CLAUDE.md §5 would be decoration.
 */

/**
 * Extraction with a citation obligation, not open-ended reasoning — but the
 * answer is only trustworthy if the model actually checks each claim against a
 * source, so this is not the place to economise down to `low`.
 */
const EFFORT = "medium" as const;

/**
 * Room for adaptive thinking plus a three-sentence answer. Thinking tokens
 * count against this, so it is not sized for the answer alone.
 */
const MAX_TOKENS = 8_000;

export interface MessagesProviderOptions {
  /**
   * Whether to ask the API to enforce the response shape server-side.
   *
   * True for the vendor. FALSE for a gateway, on purpose: `output_config` is a
   * recent addition to the Anthropic API, and a proxy is under no obligation to
   * implement every feature of the API it fronts — a gateway that rejects the
   * field would fail every request, and one that ignores it would return no
   * parsed output and look like a refusal.
   *
   * Either way the prompt states the JSON contract and zod verifies it here, so
   * the guarantee does not depend on this flag. It only decides whether the
   * server helps.
   */
  structuredOutputs: boolean;
}

export function createMessagesProvider(
  name: string,
  client: Anthropic,
  options: MessagesProviderOptions,
): LlmProvider {
  return {
    name,
    model: env.LLM_MODEL,

    async answer(input: AnswerInput, signal: AbortSignal): Promise<AnswerResult> {
      const { system, user } = renderAnswerPrompt(input);

      const response = await client.messages.parse(
        {
          model: env.LLM_MODEL,
          max_tokens: MAX_TOKENS,
          system,
          messages: [{ role: "user", content: user }],
          output_config: options.structuredOutputs
            ? { effort: EFFORT, format: zodOutputFormat(answerSchema) }
            : { effort: EFFORT },
        },
        { signal },
      );

      const parsed =
        // Present only when the server enforced the schema for us.
        (response.parsed_output as AnswerJson | null | undefined) ??
        parseFromText(response.content);

      if (!parsed) {
        // A refusal, a truncated response, or a model that ignored the
        // contract. Treated as a FAILED CALL, not as an answer with no
        // citations: the guard's "not found in your knowledge base" means the
        // corpus lacks the answer, and saying that when the model never
        // usably replied would be a lie.
        throw new Error(
          `Model returned no parseable answer (stop_reason: ${response.stop_reason})`,
        );
      }

      return {
        answer: parsed.answer,
        citations: parsed.citations,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    },
  };
}

/**
 * Pulls the JSON object out of the model's text and validates it.
 *
 * Models wrap JSON in code fences and add a sentence in front of it however
 * firmly the prompt says not to, so this finds the outermost braces rather than
 * trusting the whole string to parse. Anything that survives is still checked
 * against the same zod schema the server-enforced path uses — a malformed
 * response has to fail as a rejected answer, never as an undefined field read
 * three files away.
 */
function parseFromText(content: Anthropic.ContentBlock[]): AnswerJson | null {
  const text = content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  try {
    return answerSchema.parse(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return null;
  }
}
