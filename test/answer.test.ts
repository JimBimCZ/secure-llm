import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  UnverifiedAnswerError,
  type AnswerInput,
  type AnswerResult,
  type AnswerStreamEvent,
} from "@/server/ai/types";
import {
  askQuestion,
  askQuestionStream,
  type AskDependencies,
  type AskEvent,
} from "@/server/rag/answer";
import type { RetrievedChunk } from "@/server/rag/retrieve";
import type { Reservation } from "@/server/spend";

const chunk = (n: number, content: string): RetrievedChunk => ({
  id: `chunk-${n}`,
  documentId: `doc-${n}`,
  filename: `${n}.md`,
  chunkIndex: n,
  content,
  score: 0.8 - n / 100,
  matchedBy: ["vector"],
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
  reserveCall: async () => ({ allowed: true }),
  recordTokens: async () => {},
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

  it("reports a retracted answer as its own status, not as not_found", async () => {
    // The collector cannot say "not found in your knowledge base" here: the
    // sources were fine and the model contradicted itself. Blaming the corpus
    // for that is the untruth `messages.ts` already refuses to tell about a
    // call that never usably replied.
    const model = async function* (): AsyncGenerator<AnswerStreamEvent> {
      yield { type: "citations", citations: [1] };
      yield { type: "delta", text: "text the model never gave as its answer" };
      yield { type: "usage", inputTokens: 1, outputTokens: 1 };
      throw new UnverifiedAnswerError("does not agree with");
    };

    const result = await askQuestion("alice", "how big is the PSU?", {
      ...deps(sources, {
        answer: async () => {
          throw new Error("unused");
        },
      }),
      answerStream: () => model(),
    });

    assert.equal(result.status, "retracted");
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

  /**
   * The two daily ceilings, as the ask flow meets them.
   *
   * The reservation itself is SQL and gets no unit test — see README gap 29.
   * What IS testable here, because the dependency is injected, is the
   * orchestration around it: that a refused reservation never reaches a
   * provider, that the scope survives to the route which has to name the right
   * ceiling, and that the retry is charged as the second real call it is.
   */
  describe("the daily ceilings", () => {
    it("makes no model call when the reservation is refused", async () => {
      const model = stubModel({ answer: "750 W.", citations: [1] });
      const result = await askQuestion("alice", "q?", {
        ...deps(sources, model),
        reserveCall: async () => ({
          allowed: false,
          scope: "deployment",
          retryAfterSeconds: 3_600,
        }),
      });

      assert.equal(result.status, "budget_exhausted");
      assert.equal(model.calls.length, 0, "a refused call must not be made");
    });

    it("carries the scope out, so the route can name the right ceiling", async () => {
      const model = stubModel({ answer: "750 W.", citations: [1] });
      const result = await askQuestion("alice", "q?", {
        ...deps(sources, model),
        reserveCall: async () => ({
          allowed: false,
          scope: "user",
          retryAfterSeconds: 60,
        }),
      });

      assert.equal(result.status === "budget_exhausted" && result.scope, "user");
      assert.equal(
        result.status === "budget_exhausted" && result.retryAfterSeconds,
        60,
      );
    });

    it("charges the retry separately, and stops when it cannot", async () => {
      // The first attempt is funded and rejected by the citation guard. The
      // second has no budget, so the question ends where that rejection had
      // already left it.
      let reservations = 0;
      const model = stubModel({ answer: "Wrong.", citations: [99] });
      const result = await askQuestion("alice", "q?", {
        ...deps(sources, model),
        // Annotated because a ternary between the two arms of a discriminated
        // union widens `allowed` to `boolean` without it.
        reserveCall: async (): Promise<Reservation> => {
          reservations += 1;
          return reservations === 1
            ? { allowed: true }
            : { allowed: false, scope: "user", retryAfterSeconds: 60 };
        },
      });

      assert.equal(reservations, 2, "the retry is a second real call");
      assert.equal(model.calls.length, 1, "and it was never funded");
      assert.equal(result.status, "not_found");
      assert.equal(
        result.status === "not_found" && result.reason,
        "citations_rejected",
      );
    });

    it("records what each completed call cost", async () => {
      const charged: Array<[number, number]> = [];
      const model = stubModel({ answer: "Wrong.", citations: [99] });

      await askQuestion("alice", "q?", {
        ...deps(sources, model),
        recordTokens: async (_sub, input, output) => {
          charged.push([input, output]);
        },
      });

      // Two attempts, two costs. The stub reports 1 in and 1 out per call.
      assert.deepEqual(charged, [
        [1, 1],
        [1, 1],
      ]);
    });
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

/** A model that streams, so the ordering guarantee can be asserted. */
function stubStream(citations: number[], pieces: string[]) {
  return async function* (): AsyncGenerator<AnswerStreamEvent> {
    yield { type: "citations", citations };
    for (const text of pieces) yield { type: "delta", text };
    yield { type: "usage", inputTokens: 1, outputTokens: 1 };
  };
}

async function collectEvents(stream: AsyncGenerator<AskEvent>) {
  const events: AskEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/**
 * The same guard, met through the streaming path.
 *
 * What these add over the `askQuestion` cases above is ORDER: a collector can
 * only see what a stream ended up containing, and the promise in CLAUDE.md §6
 * is about what the user is shown BEFORE the answer is complete. Prose that
 * arrives ahead of the citations justifying it has already been read by the
 * time a late refusal arrives.
 */
describe("askQuestionStream", () => {
  it("never emits a delta before the citations that justify it", async () => {
    const model = stubStream([1], ["750 ", "W."]);
    const events = await collectEvents(
      askQuestionStream("alice", "how big is the PSU?", {
        ...deps(sources, {
          answer: async () => {
            throw new Error("unused");
          },
        }),
        answerStream: () => model(),
      }),
    );

    const kinds = events.map((e) => e.type);
    assert.ok(kinds.indexOf("citations") < kinds.indexOf("delta"));
    assert.equal(kinds.at(-1), "done");
  });

  it("shows nothing at all when the model cites a source it was not given", async () => {
    const model = stubStream([99], ["this text must never be shown"]);
    const events = await collectEvents(
      askQuestionStream("alice", "how big is the PSU?", {
        ...deps(sources, {
          answer: async () => {
            throw new Error("unused");
          },
        }),
        answerStream: () => model(),
      }),
    );

    assert.ok(!events.some((e) => e.type === "delta"));
    assert.ok(!events.some((e) => e.type === "citations"));
    assert.equal(events.at(-1)?.type, "not_found");
  });

  it("refuses an answer whose citations are valid but whose prose is empty", async () => {
    const model = stubStream([1], ["   "]);
    const events = await collectEvents(
      askQuestionStream("alice", "how big is the PSU?", {
        ...deps(sources, {
          answer: async () => {
            throw new Error("unused");
          },
        }),
        answerStream: () => model(),
      }),
    );

    assert.ok(!events.some((e) => e.type === "citations"));
    assert.equal(events.at(-1)?.type, "not_found");
  });

  it("emits the privacy event before the model is reached", async () => {
    const model = stubStream([1], ["750 W."]);
    const events = await collectEvents(
      askQuestionStream("alice", "how big is the PSU?", {
        ...deps(sources, {
          answer: async () => {
            throw new Error("unused");
          },
        }),
        answerStream: () => model(),
      }),
    );

    assert.equal(events[0]?.type, "privacy");
  });

  it("answers when the whole answer is held back by the restorer", async () => {
    // "[TBD" is withheld by the restorer until flush, which used to mean the
    // citations gate never opened and a valid answer was refused.
    const model = stubStream([1], ["[TBD"]);
    const events = await collectEvents(
      askQuestionStream("alice", "how big is the PSU?", {
        ...deps(sources, {
          answer: async () => {
            throw new Error("unused");
          },
        }),
        answerStream: () => model(),
      }),
    );

    assert.equal(events.at(-1)?.type, "done");
    assert.equal(
      events
        .filter((e) => e.type === "delta")
        .map((e) => e.text)
        .join(""),
      "[TBD",
    );
  });

  it("streams the answer byte for byte, leading whitespace included", async () => {
    // The non-streaming path returned the model's answer verbatim. Text the
    // gate held back while waiting for something visible is shown, not dropped.
    const model = stubStream([1], ["   ", "750 W."]);
    const events = await collectEvents(
      askQuestionStream("alice", "how big is the PSU?", {
        ...deps(sources, {
          answer: async () => {
            throw new Error("unused");
          },
        }),
        answerStream: () => model(),
      }),
    );

    assert.equal(
      events
        .filter((e) => e.type === "delta")
        .map((e) => e.text)
        .join(""),
      "   750 W.",
    );
  });

  it("records spend even when the consumer stops reading", async () => {
    // A reserved call that the client walked away from is still a call that
    // was made. Nothing downstream charges it if this does not.
    const charged: number[][] = [];
    const model = stubStream([1], ["750 ", "W."]);
    const stream = askQuestionStream("alice", "how big is the PSU?", {
      ...deps(sources, {
        answer: async () => {
          throw new Error("unused");
        },
      }),
      answerStream: () => model(),
      recordTokens: async (_sub, i, o) => {
        charged.push([i, o]);
      },
    });

    for await (const event of stream) if (event.type === "delta") break;

    assert.equal(charged.length, 1);
  });

  it("charges a streaming call the guard rejected", async () => {
    // A rejected call is charged exactly like an accepted one — the same
    // invariant `oneShot` keeps by yielding usage first, and the one ai/call.ts
    // keeps for a call that times out. A streaming provider can only know its
    // token counts at the end, so abandoning the stream the moment the
    // citations are rejected charged the most reachable failure in the system
    // nothing at all. The stream is drained instead.
    const charged: Array<[number, number]> = [];
    const model = async function* (): AsyncGenerator<AnswerStreamEvent> {
      yield { type: "citations", citations: [99] };
      yield { type: "delta", text: "this text must never be shown" };
      yield { type: "usage", inputTokens: 500, outputTokens: 4_000 };
    };

    const events = await collectEvents(
      askQuestionStream("alice", "how big is the PSU?", {
        ...deps(sources, {
          answer: async () => {
            throw new Error("unused");
          },
        }),
        answerStream: () => model(),
        recordTokens: async (_sub, input, output) => {
          charged.push([input, output]);
        },
      }),
    );

    // Two attempts, both rejected, both charged what the provider reported.
    assert.deepEqual(charged, [
      [500, 4_000],
      [500, 4_000],
    ]);

    // Draining must not leak: the prose that followed the rejected citations
    // reached the orchestrator and had to be dropped, not shown.
    assert.ok(!events.some((e) => e.type === "delta"));
    assert.ok(!events.some((e) => e.type === "citations"));
    assert.equal(events.at(-1)?.type, "not_found");
  });

  it("retracts what it streamed when the finished reply cannot vouch for it", async () => {
    // The residual this slice exists to close. The prose and its sources really
    // did go out — the provider only learns the reply contradicts them once the
    // whole message has arrived — so a terminal event that merely says "error"
    // leaves them on screen, labelled incomplete but readable. `retracted` is
    // the instruction to take them back.
    const charged: Array<[number, number]> = [];
    const model = async function* (): AsyncGenerator<AnswerStreamEvent> {
      yield { type: "citations", citations: [1] };
      yield { type: "delta", text: "text the model never gave as its answer" };
      yield { type: "usage", inputTokens: 500, outputTokens: 900 };
      throw new UnverifiedAnswerError(
        "Model streamed prose its final answer does not agree with",
      );
    };

    const reservations: string[] = [];
    const events = await collectEvents(
      askQuestionStream("alice", "how big is the PSU?", {
        ...deps(sources, {
          answer: async () => {
            throw new Error("unused");
          },
        }),
        answerStream: () => model(),
        reserveCall: async (sub) => {
          reservations.push(sub);
          return { allowed: true };
        },
        recordTokens: async (_sub, input, output) => {
          charged.push([input, output]);
        },
      }),
    );

    assert.equal(events.at(-1)?.type, "retracted");
    // Not a citation-guard rejection: the guard passed, and a stricter prompt
    // has nothing to fix. One call, not two.
    assert.deepEqual(reservations, ["alice"]);
    assert.ok(!events.some((e) => e.type === "not_found"));
    // Refusing the answer and recording the cost stay separate decisions.
    assert.deepEqual(charged, [[500, 900]]);
  });

  it("does not withdraw an answer it never showed", async () => {
    // The same unverified reply, caught before anything went out — the model
    // wrapped its JSON in prose, so the scanner never anchored and the citation
    // event never fired. There is nothing on screen to take back, and telling
    // a reader their answer was withdrawn when they never saw one explains a
    // thing that did not happen. It stays an ordinary failed call.
    const model = async function* (): AsyncGenerator<AnswerStreamEvent> {
      yield { type: "usage", inputTokens: 1, outputTokens: 1 };
      throw new UnverifiedAnswerError("Model returned no parseable answer");
    };

    await assert.rejects(
      () =>
        collectEvents(
          askQuestionStream("alice", "how big is the PSU?", {
            ...deps(sources, {
              answer: async () => {
                throw new Error("unused");
              },
            }),
            answerStream: () => model(),
          }),
        ),
      /no parseable answer/,
    );
  });

  it("lets a dropped connection stay a cut-short answer", async () => {
    // The other half of the distinction: what streamed before the drop is
    // genuine prose, so it keeps the behaviour slice 18 chose for it. The error
    // propagates and the route turns it into `error`, never `retracted`.
    const model = async function* (): AsyncGenerator<AnswerStreamEvent> {
      yield { type: "citations", citations: [1] };
      yield { type: "delta", text: "750 " };
      yield { type: "usage", inputTokens: 1, outputTokens: 1 };
      throw new Error("socket hang up");
    };

    await assert.rejects(
      () =>
        collectEvents(
          askQuestionStream("alice", "how big is the PSU?", {
            ...deps(sources, {
              answer: async () => {
                throw new Error("unused");
              },
            }),
            answerStream: () => model(),
          }),
        ),
      /socket hang up/,
    );
  });

  it("shows no placeholder syntax when the stream fails mid-placeholder", async () => {
    // README gap 39 claimed a drop inside a placeholder puts `[EMAIL_` on
    // screen. It cannot: the restorer's held suffix is released by `flush()`,
    // which the failing path never reaches. Pinned here so a future `finally`
    // around the flush cannot reintroduce it silently.
    const personal = [chunk(1, "Ask marek.dvorak@example.com about the unit.")];
    const model = async function* (): AsyncGenerator<AnswerStreamEvent> {
      yield { type: "citations", citations: [1] };
      yield { type: "delta", text: "Write to " };
      yield { type: "delta", text: "[EMAIL_" };
      throw new Error("socket hang up");
    };

    const events: AskEvent[] = [];
    await assert.rejects(async () => {
      for await (const event of askQuestionStream("alice", "who owns it?", {
        ...deps(personal, {
          answer: async () => {
            throw new Error("unused");
          },
        }),
        answerStream: () => model(),
      })) {
        events.push(event);
      }
    }, /socket hang up/);

    const shown = events
      .filter((e) => e.type === "delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    assert.equal(shown, "Write to ");
    assert.ok(!shown.includes("[EMAIL_"), "no placeholder syntax reached the user");
  });

  it("ignores a second citations set", async () => {
    // A later set cannot retroactively justify prose already shown, and must
    // not slip past a gate the first set opened.
    const model = async function* () {
      yield { type: "citations", citations: [1] };
      yield { type: "delta", text: "750 W." };
      yield { type: "citations", citations: [99] };
      yield { type: "usage", inputTokens: 1, outputTokens: 1 };
    };
    const events = await collectEvents(
      askQuestionStream("alice", "how big is the PSU?", {
        ...deps(sources, {
          answer: async () => {
            throw new Error("unused");
          },
        }),
        answerStream: () => model() as AsyncGenerator<AnswerStreamEvent>,
      }),
    );

    assert.equal(events.at(-1)?.type, "done");
    assert.equal(events.filter((e) => e.type === "citations").length, 1);
  });
});
