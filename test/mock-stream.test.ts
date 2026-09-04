import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMockLlmProvider } from "@/server/ai/providers/mock";
import type { AnswerStreamEvent } from "@/server/ai/types";

const input = {
  question: "how big is the PSU?",
  chunks: [
    {
      id: "c1",
      documentId: "d1",
      content: "The PSU is rated 750 W and it has stayed cool under load for a year.",
    },
  ],
};

async function collect(stream: AsyncIterable<AnswerStreamEvent>) {
  const events: AnswerStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("mock answerStream", () => {
  it("emits citations before any delta, then usage last", async () => {
    const provider = createMockLlmProvider();
    const events = await collect(provider.answerStream!(input, AbortSignal.timeout(5_000)));

    const kinds = events.map((e) => e.type);
    assert.equal(kinds[0], "citations");
    assert.equal(kinds.at(-1), "usage");
    assert.ok(kinds.indexOf("delta") > kinds.indexOf("citations"));
  });

  it("streams the same answer the non-streaming call returns", async () => {
    const provider = createMockLlmProvider();
    const whole = await provider.answer(input, AbortSignal.timeout(5_000));
    const events = await collect(provider.answerStream!(input, AbortSignal.timeout(5_000)));

    const streamed = events
      .filter((e): e is Extract<AnswerStreamEvent, { type: "delta" }> => e.type === "delta")
      .map((e) => e.text)
      .join("");

    assert.equal(streamed, whole.answer);
  });
});
