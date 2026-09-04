import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import { readPartial } from "@/server/ai/partialJson";
import { renderAnswerPrompt } from "@/server/ai/prompts";
import { answerSchema, type AnswerJson } from "@/server/ai/providers/schema";
import type {
  AnswerInput,
  AnswerResult,
  AnswerStreamEvent,
  LlmProvider,
} from "@/server/ai/types";
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

  /**
   * Whether this provider exposes `answerStream`.
   *
   * TRUE only where streaming has been run against a live service. It is off
   * for the vendor and the gateway stub for the reason README gaps 1 and 2
   * give: streaming is event framing, partial JSON, usage placement and abort
   * behaviour all at once, and a wire-format document tells you least about
   * exactly those. Shipping it unexercised would put
   * verification-by-construction on the seam CLAUDE.md §5 calls the most
   * important in the project. Turning it on later is this one flag.
   */
  streaming: boolean;
}

export function createMessagesProvider(
  name: string,
  client: Anthropic,
  options: MessagesProviderOptions,
): LlmProvider {
  const provider: LlmProvider = {
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

  // ABSENCE is the signal. ai/call.ts asks `provider.answerStream !== undefined`
  // and routes the call through the whole-answer path when it is, so the flag
  // has to decide whether the PROPERTY EXISTS — not whether the method behind it
  // does anything. A method that was present and refused would be a defect
  // wearing the interface's clothes.
  if (!options.streaming) return provider;

  return {
    ...provider,

    /**
     * The same request as `answer`, read as it arrives.
     *
     * Two properties are load-bearing, and they pull in opposite directions.
     * Nothing may be emitted before the citation array is complete, because the
     * guard in rag/answer.ts rules on that array and prose sent ahead of it
     * would be prose the guard has not seen. And field order must cost latency,
     * never correctness: a model that ignores the prompt's ordering still has
     * to get the right answer, just not an early one. The loop below buys the
     * first with `readPartial`; the block after it pays for the second.
     *
     * And whatever the loop did, the call ends by validating the COMPLETE
     * message the way `answer` does. Streaming may only ever make an accepted
     * reply arrive sooner — never make a reply acceptable that the
     * whole-answer path would have refused.
     */
    async *answerStream(
      input: AnswerInput,
      signal: AbortSignal,
    ): AsyncGenerator<AnswerStreamEvent> {
      const { system, user } = renderAnswerPrompt(input);

      // `stream()` rather than `parse()`, and otherwise the identical request:
      // the SDK hands back the server-sent events as they arrive and
      // accumulates them into the message `finalMessage()` returns below.
      //
      // `signal` reaches the underlying request, so a call we stop waiting for
      // is actually cancelled rather than merely abandoned — same reasoning as
      // the note on `LlmProvider.answer`. The SDK's iterator also aborts on
      // `return()`, so a consumer that breaks out of this generator early
      // cancels the request too.
      const stream = client.messages.stream(
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

      /** The JSON object so far — text deltas only, in arrival order. */
      let accumulated = "";
      /**
       * The citation set already emitted, or null while none has been.
       *
       * The VALUE and not just a flag, because the check after the loop has to
       * confirm that what went out early is what the reply actually ended up
       * saying.
       */
      let sentCitations: number[] | null = null;
      /** How many characters of the answer have already gone out as deltas. */
      let sentUpTo = 0;

      for await (const event of stream) {
        // The SDK re-emits the raw wire events, and text is the only kind that
        // carries the answer. Thinking and signature deltas belong to the same
        // response but not to the JSON, and letting them into the buffer would
        // corrupt the very thing `readPartial` is scanning.
        if (
          event.type !== "content_block_delta" ||
          event.delta.type !== "text_delta"
        ) {
          continue;
        }

        accumulated += event.delta.text;
        const { citations, answerSoFar } = readPartial(accumulated);

        // Nothing may be emitted before the citation array is whole: the guard
        // downstream needs it, and prose sent ahead of it would be prose the
        // guard has not seen. `readPartial` reports "not yet" rather than a
        // guess, so this is a wait and never a gamble.
        if (citations === null) continue;

        if (sentCitations === null) {
          yield { type: "citations", citations };
          sentCitations = citations;
        }

        if (answerSoFar.length > sentUpTo) {
          yield { type: "delta", text: answerSoFar.slice(sentUpTo) };
          sentUpTo = answerSoFar.length;
        }
      }

      const final = await stream.finalMessage();

      // Built once, emitted on both ways out of this function. Last on the
      // happy path, because token counts are only final when the call is:
      // input tokens arrive with the first wire event and output tokens with
      // the last, and the accumulated message is the one place both are
      // settled.
      const usage: AnswerStreamEvent = {
        type: "usage",
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
      };

      // A truncated answer is REFUSED, even though prose has already gone out.
      //
      // `answer` above has always refused this reply: cut off at the ceiling,
      // the JSON never closes, `parseFromText` returns null and the call fails
      // as a failed call. Streaming it does not make it a better answer — it
      // makes it a worse one, because the citations landed first and the
      // fragment therefore arrives looking fully sourced. Showing it would be
      // the app claiming the model finished when it did not.
      //
      // Throwing after emitting is not a contradiction here: the route turns a
      // mid-stream throw into a terminal `error` event, and the UI keeps the
      // partial answer and its sources on screen and marks them incomplete. So
      // the user sees exactly what the model produced, labelled honestly, which
      // beats both silently keeping it and pretending it never arrived.
      //
      // The cost is reported first, and then the call fails. Refusing the
      // ANSWER and recording the COST are separate decisions, and this project
      // has always kept them apart: a timed-out call is charged (README gap
      // 14), and slice 15 reserves the call before it is made. This is the most
      // expensive call the model can produce — it spent the entire output
      // budget by definition — and the counts are right there on the final
      // message, so recording it as free would be the exact inverse of the
      // truth in both the audit row and the day's spend.
      if (final.stop_reason === "max_tokens") {
        yield usage;
        throw new Error("Model ran out of output tokens (stop_reason: max_tokens)");
      }

      // The complete reply is validated ALWAYS — whether or not anything was
      // streamed — because `readPartial` is a FAST PATH, not an authority.
      //
      // It scans a buffer that has not finished arriving, so it cannot know
      // that the well-formed object it just read is one of two, or that the
      // reply ends in a shape the schema rejects. A model that echoes the
      // prompt's example before answering — `Example: {…} Actual: {…}` — hands
      // it a complete citation array belonging to the EXAMPLE, and it will
      // happily stream the example as the answer. `answer` above refuses that
      // identical reply, because `parseFromText` spans the first brace to the
      // last and `JSON.parse` chokes on two objects; so does a reply with no
      // `answer` field, or one whose `answer` is a number, because zod says so.
      //
      // Making that check conditional on having streamed nothing is what turned
      // a failed call into a confidently wrong one. So the streaming path now
      // ENDS where the non-streaming path ends: the reply is accepted only if
      // the complete object still parses, and still parses to BOTH of what
      // went out — the citations AND the prose, checked below as two separate
      // comparisons. A reply with a `meta.answer` field ahead of the real
      // `answer` is why the second half exists: `readPartial` anchors on the
      // FIRST `"answer"` key it finds in the buffer, so a nested decoy streams
      // as if it were the answer while the citations it streams alongside are
      // the real, validated ones. The citation cross-check alone passed that
      // reply — same citations either way — so the user read a string the
      // model never gave as its answer, attributed to a real source. Comparing
      // the prose too closes that gap the same way: any disagreement is a
      // refusal, never a display.
      const parsed =
        // Present only when the server enforced the schema for us.
        (final.parsed_output as AnswerJson | null | undefined) ??
        parseFromText(final.content);

      if (!parsed) {
        // The same judgement `answer` makes above, for the same reason: a call
        // that never usably replied is a FAILED CALL, not an answer with no
        // citations. Calling it the latter would have the app blame the corpus
        // for the model's failure.
        yield usage;
        throw new Error(
          `Model returned no parseable answer (stop_reason: ${final.stop_reason})`,
        );
      }

      if (sentCitations === null) {
        // Nothing was streamed: the model put `answer` before `citations`, or
        // wrapped the object in prose. The whole reply goes out now — the same
        // events, in the same order, the non-streaming path would have
        // produced. That is the degradation this design accepts, and it is why
        // field order costs latency and never correctness.
        //
        // It cannot double-emit: a `delta` is reachable only inside the branch
        // that assigns `sentCitations`, so this block and the loop above are
        // mutually exclusive by construction rather than by being careful.
        yield { type: "citations", citations: parsed.citations };
        yield { type: "delta", text: parsed.answer };
      } else if (
        sentCitations.length !== parsed.citations.length ||
        sentCitations.some((n, i) => n !== parsed.citations[i])
      ) {
        // What went out early is not what the reply ended up citing, so the
        // sources the user was shown are not the model's. One comparison, and
        // it is the direct guard against having latched onto an echoed example
        // that happened to parse on its own.
        yield usage;
        throw new Error(
          "Model streamed a citation set its final answer does not agree with",
        );
      } else if (readPartial(accumulated).answerSoFar !== parsed.answer) {
        // The citation-only twin of the check above, and the one this reply
        // needed: `{"citations": [1], "meta": {"answer": "…"}, "answer": "…"}`
        // streams the correct citations — there is only one `"citations"` key
        // to anchor on — but `readAnswer` anchors `"answer"` to the FIRST
        // occurrence in the buffer, which here is the decoy nested inside
        // `meta`. The prose that went out is therefore not the prose the
        // validated reply actually contains, and no amount of citations
        // agreeing changes that. Re-reading `accumulated` here rather than
        // trusting a value captured mid-loop matters for the ordinary case
        // too: `accumulated` is exactly what it was when the loop's last
        // iteration read it, so an unremarkable reply that finished streaming
        // cleanly compares equal and is never caught by this net meant for
        // decoys.
        yield usage;
        throw new Error(
          "Model streamed prose its final answer does not agree with",
        );
      }

      yield usage;
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
