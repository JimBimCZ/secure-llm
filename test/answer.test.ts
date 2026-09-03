import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AnswerInput, AnswerResult } from "@/server/ai/types";
import { askQuestion, type AskDependencies } from "@/server/rag/answer";
import type { RetrievedChunk } from "@/server/rag/retrieve";

const chunk = (n: number, content: string): RetrievedChunk => ({
  id: `chunk-${n}`,
  documentId: `doc-${n}`,
  filename: `${n}.md`,
  chunkIndex: n,
  content,
  score: 0.8 - n / 100,
  matchedBy: "vector",
});

/** Records what the model was actually sent, and replies as told. */
function stubModel(...replies: Omit<AnswerResult, "usage">[]) {
  const calls: AnswerInput[] = [];

  const answer = async (input: AnswerInput): Promise<AnswerResult> => {
    calls.push(input);
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return { ...reply, usage: { inputTokens: 1, outputTokens: 1 } };
  };

  return { calls, answer };
}

const deps = (
  chunks: RetrievedChunk[],
  model: { answer: AskDependencies["answer"] },
): AskDependencies => ({
  retrieve: async () => chunks,
  answer: model.answer,
});

const sources = [chunk(1, "The PSU is rated 750 W."), chunk(2, "Two fans.")];

/**
 * The citation guard as the user meets it: not `resolveCitations` in isolation,
 * but the decision to ship an answer or refuse one.
 *
 * The rejection path is the reason this file exists. It fires when a model
 * cites a source it was never given, and nothing in the repository can produce
 * that on demand — the mock answerer cites what it extracted, and a real model
 * misbehaves when it feels like it, not when a test needs it to. A stub does it
 * every time.
 */
describe("askQuestion", () => {
  it("answers when the citations check out", async () => {
    const model = stubModel({ answer: "750 W.", citations: [1] });
    const result = await askQuestion("alice", "how big is the PSU?", deps(sources, model));

    assert.equal(result.status, "answered");
    assert.equal(result.status === "answered" && result.answer, "750 W.");
    assert.deepEqual(
      result.status === "answered" && result.citations.map((c) => c.chunkId),
      ["chunk-1"],
    );
  });

  it("refuses an answer whose citation is not in the retrieved set", async () => {
    // The fabricated citation, twice. This is the branch the whole guard is for.
    const model = stubModel({ answer: "Confidently wrong.", citations: [99] });
    const result = await askQuestion("alice", "how big is the PSU?", deps(sources, model));

    assert.equal(result.status, "not_found");
    assert.equal(
      result.status === "not_found" && result.reason,
      "citations_rejected",
    );
  });

  it("retries once with the stricter prompt, then stops", async () => {
    const model = stubModel({ answer: "Wrong.", citations: [99] });
    await askQuestion("alice", "q?", deps(sources, model));

    assert.equal(model.calls.length, 2, "one call, then one retry");
    assert.equal(model.calls[0]?.retry, false);
    assert.equal(model.calls[1]?.retry, true);
  });

  it("accepts an answer the retry got right", async () => {
    const model = stubModel(
      { answer: "Wrong.", citations: [99] },
      { answer: "750 W.", citations: [2] },
    );
    const result = await askQuestion("alice", "q?", deps(sources, model));

    assert.equal(result.status, "answered");
    assert.equal(model.calls.length, 2);
  });

  it("refuses an answer with no citations at all", async () => {
    const model = stubModel({ answer: "I think so.", citations: [] });
    const result = await askQuestion("alice", "q?", deps(sources, model));

    assert.equal(result.status, "not_found");
  });

  it("refuses an empty answer even with a valid citation", async () => {
    // A citation without an answer supports nothing.
    const model = stubModel({ answer: "   ", citations: [1] });
    const result = await askQuestion("alice", "q?", deps(sources, model));

    assert.equal(result.status, "not_found");
  });

  it("never calls the model when nothing was retrieved", async () => {
    const model = stubModel({ answer: "x", citations: [1] });
    const result = await askQuestion("alice", "q?", deps([], model));

    assert.equal(result.status, "not_found");
    assert.equal(
      result.status === "not_found" && result.reason,
      "no_relevant_chunks",
    );
    assert.equal(model.calls.length, 0, "no chunks, no reason to pay for a call");
  });

  describe("anonymization round trip", () => {
    const personal = [
      chunk(1, "Ask marek.dvorak@example.com about the 750 W unit."),
    ];

    it("sends no personal data to the model", async () => {
      const model = stubModel({ answer: "Ask [EMAIL_1].", citations: [1] });
      await askQuestion(
        "alice",
        "who owns marek.dvorak@example.com?",
        deps(personal, model),
      );

      const sent = JSON.stringify(model.calls[0]);
      assert.ok(!sent.includes("marek.dvorak@example.com"), "no address left");
      assert.ok(sent.includes("[EMAIL_1]"), "replaced, not deleted");
    });

    it("gives one value the same placeholder in the question and the chunks", async () => {
      // Otherwise a question about someone stops matching the chunk about them.
      const model = stubModel({ answer: "Yes.", citations: [1] });
      await askQuestion(
        "alice",
        "who owns marek.dvorak@example.com?",
        deps(personal, model),
      );

      const call = model.calls[0]!;
      assert.ok(call.question.includes("[EMAIL_1]"));
      assert.ok(call.chunks[0]?.content.includes("[EMAIL_1]"));
    });

    it("puts the personal data back into the answer", async () => {
      const model = stubModel({ answer: "Ask [EMAIL_1].", citations: [1] });
      const result = await askQuestion("alice", "who?", deps(personal, model));

      assert.equal(
        result.status === "answered" && result.answer,
        "Ask marek.dvorak@example.com.",
      );
    });

    it("reports what it redacted, without reporting the values", async () => {
      const model = stubModel({ answer: "Ask [EMAIL_1].", citations: [1] });
      const result = await askQuestion(
        "alice",
        "who owns marek.dvorak@example.com?",
        deps(personal, model),
      );

      assert.equal(result.status, "answered");
      if (result.status !== "answered") return;

      assert.equal(result.privacy.replaced.emails, 1);
      assert.equal(
        result.privacy.redactedQuestion,
        "who owns [EMAIL_1]?",
        "the question exactly as it left the process",
      );
    });
  });
});
