import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

import type { AnswerInput, AnswerStreamEvent, LlmProvider } from "@/server/ai/types";

/**
 * The streaming half of the shared Messages call path, against a stub that
 * speaks the Anthropic server-sent-event framing.
 *
 * Same argument as `gateway.test.ts`, which pins the non-streaming request the
 * same way: the half that lives in this repository can be read, and a local
 * stub is not a network dependency. Nothing else in the suite executes a line
 * of the streaming provider, and the two properties it exists to guarantee —
 * that no prose escapes before the citation array is whole, and that field
 * order costs latency rather than correctness — are exactly the kind that
 * typechecking cannot see.
 *
 * It drives `createMessagesProvider` with `streaming: true` rather than
 * `createOpenRouterProvider`, because that factory hard-codes OpenRouter's
 * address. The construction here is the one that file performs, minus the base
 * URL; a live run against the real service is a separate exercise.
 */

/** How much of the answer a stub delivers per event: one character. */
const sse = (
  text: string,
  stopReason: "end_turn" | "max_tokens" = "end_turn",
): string => {
  const pieces: string[] = [];
  const push = (event: string, data: unknown) =>
    pieces.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  push("message_start", {
    type: "message_start",
    message: {
      id: "msg_stub",
      type: "message",
      role: "assistant",
      model: "stub-model",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 0 },
    },
  });
  push("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  // A character at a time, which is the meanest framing a model could produce
  // and the one most likely to catch a partial-JSON reader out.
  for (const character of text) {
    push("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: character },
    });
  }
  push("content_block_stop", { type: "content_block_stop", index: 0 });
  push("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 22 },
  });
  push("message_stop", { type: "message_stop" });

  return pieces.join("");
};

/** The body the stub will answer with next. Set by each test before it calls. */
let payload = "";

function stubStreamingService() {
  let server: Server;

  const start = () =>
    new Promise<string>((resolve) => {
      server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(payload);
      });
      // Port 0: the OS picks a free one, so the test cannot collide with
      // anything already running on this machine.
      server.listen(0, "127.0.0.1", () => {
        // Unreferenced, so an open socket can never be the reason this suite
        // fails to exit. `after` below closes it whatever the tests did —
        // node:test runs that hook even when an assertion throws — and this is
        // the belt to that pair of braces.
        server.unref();
        const address = server.address();
        resolve(
          `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`,
        );
      });
    });

  const stop = () => new Promise<void>((resolve) => server.close(() => resolve()));

  return { start, stop };
}

const input: AnswerInput = {
  question: "how big is the PSU?",
  chunks: [{ id: "c1", documentId: "d1", content: "The PSU is rated 750 W." }],
};

const usageEvent = { type: "usage", inputTokens: 11, outputTokens: 22 };

describe("openrouter streaming", () => {
  const stub = stubStreamingService();
  let provider: LlmProvider;

  /** Drains the stream. Throws whatever the provider threw, having kept what it emitted. */
  const collect = async (emitted: AnswerStreamEvent[] = []) => {
    for await (const event of provider.answerStream!(input, AbortSignal.timeout(5_000))) {
      emitted.push(event);
    }
    return emitted;
  };

  before(async () => {
    const baseUrl = await stub.start();

    // Set before `env` is first imported, which is why the imports below are
    // dynamic: the schema reads the environment once, at module load.
    process.env.LLM_MODEL = "stub-model";

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const { createMessagesProvider } = await import("@/server/ai/providers/messages");

    provider = createMessagesProvider(
      "openrouter",
      new Anthropic({ baseURL: baseUrl, apiKey: null, authToken: "not-a-real-token" }),
      { structuredOutputs: false, streaming: true },
    );
  });

  after(() => stub.stop());

  it("emits the citations before any prose, and streams the prose", async () => {
    payload = sse('{"citations": [1], "answer": "The PSU is rated 750 W."}');
    const events = await collect();

    assert.deepEqual(events[0], { type: "citations", citations: [1] });

    const deltas = events.filter((event) => event.type === "delta");
    // More than one, or this is not streaming — it is one lump wearing the
    // shape of a stream.
    assert.ok(deltas.length > 1, `expected several deltas, got ${deltas.length}`);
    // Byte for byte: a streaming path that drops a character shows a different
    // answer than the one the guard approved.
    assert.equal(
      deltas.map((event) => (event as { text: string }).text).join(""),
      "The PSU is rated 750 W.",
    );

    // Last, and carrying the counts the wire reported at either end of the call:
    // input tokens with the first event, output tokens with the last.
    assert.deepEqual(events.at(-1), usageEvent);
  });

  it("holds every character of prose until the citation array closes", async () => {
    // Field order reversed, so the whole answer is in the buffer before the
    // citations are. Nothing may go out in the meantime, and the answer must
    // still arrive whole: field order costs latency, never correctness.
    payload = sse('{"answer": "The PSU is rated 750 W.", "citations": [1]}');

    assert.deepEqual(await collect(), [
      { type: "citations", citations: [1] },
      { type: "delta", text: "The PSU is rated 750 W." },
      usageEvent,
    ]);
  });

  it("recovers the whole answer when the stream yielded nothing readable", async () => {
    // The answer text carries an escaped `"citations":` whose value is not an
    // array. `readPartial` refuses to anchor to the decoy — that refusal is the
    // reason it anchors values to their keys at all — so it reports "not yet"
    // for the entire stream and the loop emits nothing. This is the one case
    // that reaches the recovery's SUCCESS branch, and the exact event list is
    // the double-emit check: three events, no repeated citations.
    payload = sse(
      JSON.stringify({
        answer: 'The "citations": field was mistyped.',
        citations: [1],
      }),
    );

    assert.deepEqual(await collect(), [
      { type: "citations", citations: [1] },
      { type: "delta", text: 'The "citations": field was mistyped.' },
      usageEvent,
    ]);
  });

  it("refuses a reply it cannot parse, rather than answering with no citations", async () => {
    // A refusal or a model that ignored the contract. Treated as a FAILED CALL
    // for the same reason the whole-answer path treats it as one: "not found in
    // your knowledge base" would blame the corpus for the model never replying.
    payload = sse("I cannot help with that.");

    await assert.rejects(() => collect(), /no parseable answer/);
  });

  it("refuses a truncated answer but still charges for it", async () => {
    // Cut off at the ceiling mid-sentence, with the citations already sent. The
    // fragment is the most dangerous shape this provider can produce — it looks
    // fully sourced — so it is refused, and the UI marks what it already showed
    // as incomplete instead of presenting it as the whole answer.
    payload = sse('{"citations": [1], "answer": "The PSU is rat', "max_tokens");

    const emitted: AnswerStreamEvent[] = [];
    await assert.rejects(() => collect(emitted), /max_tokens/);

    // It really had gone out already: this is a refusal issued after the fact,
    // not the truncation being caught before anything was shown.
    assert.deepEqual(emitted[0], { type: "citations", citations: [1] });
    assert.ok(emitted.some((event) => event.type === "delta"));

    // The pairing is the property worth pinning: A REFUSED ANSWER IS STILL A
    // CHARGED CALL. Refusing the answer and recording the cost are separate
    // decisions, and this is the call that makes the difference largest — it
    // spent the whole output budget by definition, so dropping the counts would
    // record the most expensive call in the system as free.
    assert.deepEqual(emitted.at(-1), usageEvent);
  });
});
