# Streaming answers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream an answer's prose to the user as it is generated, without ever showing a word that the citation guard has not already validated.

**Architecture:** `citations` moves ahead of `answer` in the model's JSON contract, so the guard can run on the citation array while the prose is still arriving. One async generator (`askQuestionStream`) is the single implementation of the guard; today's `askQuestion` becomes a collector over it. The route streams NDJSON, and a provider that cannot stream produces one big delta — so route, protocol and UI each have exactly one path.

**Tech Stack:** TypeScript, Next.js App Router route handler returning a `ReadableStream`, `@anthropic-ai/sdk` streaming for OpenRouter, `node:test` for unit tests, Drizzle for the one migration.

**Spec:** `docs/superpowers/specs/2026-09-03-streaming-answers-design.md` — read it first; this plan argues from it.

## Global Constraints

- **The citation guard exists exactly once.** Any task that produces a second copy of it is wrong, however convenient.
- **A `delta` event never precedes its `citations` event.** This is CLAUDE.md §6 expressed in the wire format.
- **No prompt text in TypeScript** (CLAUDE.md §3). Prompts live in `prompts/*.md` and are loaded at runtime.
- **The audit record carries no content** (§3): numbers, identifiers, timestamps and outcomes only.
- **The app must be fully demoable with no API key** (§5): `mock` streams.
- **No new dependency** unless 30 lines of clear code cannot do it (§8). This plan adds none.
- **Every env var** added would need `.env.example`, the zod schema and the README. This plan adds none.
- `npm test` and `npm run typecheck` pass at the end of every task.
- Commit at the end of every task, conventional prefix, imperative mood, the *why* in the body.

## Two refinements to the spec, found while planning

Both are improvements the spec's own reasoning implies; implement these, not the spec's earlier wording.

1. **`citations` is emitted lazily, on the first non-empty delta — not the instant it validates.** The guard has two halves: citations resolve *and* the answer is non-empty. Citations-first lets the first half run early, but the second can only be known when prose exists. Holding the `citations` event until the first non-whitespace delta preserves both halves and the protocol invariant: a model that returns valid citations and no prose emits `not_found`, having shown nothing.
2. **`AskDependencies` gains an optional `answerStream`, rather than changing `answer`.** This mirrors the provider seam exactly and leaves every existing test in `test/answer.test.ts` literally unchanged — which is the evidence that the restructuring in Task 4 preserved behaviour.

---

### Task 1: `readPartial` — pull citations and partial prose out of half-arrived JSON

**Files:**
- Create: `src/server/ai/partialJson.ts`
- Test: `test/partialJson.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `readPartial(accumulated: string): { citations: number[] | null; answerSoFar: string }`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readPartial } from "@/server/ai/partialJson";

describe("readPartial", () => {
  it("returns null citations until the array closes", () => {
    assert.equal(readPartial('{"citations": [1, 2').citations, null);
    assert.deepEqual(readPartial('{"citations": [1, 2]').citations, [1, 2]);
  });

  it("reads the answer as far as it has arrived", () => {
    const partial = '{"citations": [1], "answer": "The PSU is rated';
    assert.equal(readPartial(partial).answerSoFar, "The PSU is rated");
  });

  it("decodes escapes inside the answer", () => {
    const json = '{"citations": [1], "answer": "a \\"quote\\" and a \\\\ and \\n"';
    assert.equal(readPartial(json).answerSoFar, 'a "quote" and a \\ and \n');
  });

  it("holds back a half-arrived escape rather than guessing", () => {
    assert.equal(readPartial('{"answer": "ab\\').answerSoFar, "ab");
    assert.equal(readPartial('{"answer": "ab\\u00').answerSoFar, "ab");
    assert.equal(readPartial('{"answer": "ab\\u00e9').answerSoFar, "abé");
  });

  it("stops at the closing quote", () => {
    const done = '{"citations": [1], "answer": "done"}';
    assert.equal(readPartial(done).answerSoFar, "done");
  });

  it("survives a field order the prompt did not ask for", () => {
    const reversed = '{"answer": "text", "citations": [2]}';
    assert.deepEqual(readPartial(reversed).citations, [2]);
    assert.equal(readPartial(reversed).answerSoFar, "text");
  });

  it("never throws on malformed input", () => {
    for (const bad of ["", "not json", "{", '{"citations": "nope"}', '{"citations": [1,]']) {
      assert.doesNotThrow(() => readPartial(bad));
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- --test-name-pattern="readPartial"`
Expected: FAIL — cannot find module `@/server/ai/partialJson`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Reads a JSON object that has not finished arriving.
 *
 * The streaming answer path needs two things out of a partial response: the
 * citation array as soon as it is complete, so the guard can run before any
 * prose is shown, and the prose so far, so it can be streamed. `JSON.parse`
 * gives neither until the last brace lands, which is exactly the wait this
 * slice exists to remove.
 *
 * It is deliberately a scanner and not a parser. It answers two questions
 * about a known shape rather than modelling JSON, and anything it cannot
 * answer yet it reports as "not yet" — never as a guess. A malformed response
 * must fail as a rejected answer somewhere that says so, never as a wrong
 * string read three files away.
 */

export interface PartialAnswer {
  /** Complete and well-formed, or null while it is still arriving. */
  citations: number[] | null;
  /** The decoded prefix of `answer`. Empty until the string opens. */
  answerSoFar: string;
}

const CITATIONS_KEY = '"citations"';
const ANSWER_KEY = '"answer"';

/** The single-character escapes JSON defines. `\u` is handled separately. */
const UNESCAPE: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

export function readPartial(accumulated: string): PartialAnswer {
  const start = accumulated.indexOf("{");
  if (start === -1) return { citations: null, answerSoFar: "" };

  const body = accumulated.slice(start);
  return { citations: readCitations(body), answerSoFar: readAnswer(body) };
}

function readCitations(body: string): number[] | null {
  const key = body.indexOf(CITATIONS_KEY);
  if (key === -1) return null;

  const open = body.indexOf("[", key + CITATIONS_KEY.length);
  if (open === -1) return null;

  // No nesting to worry about: the contract says integers, so the first `]`
  // ends the array. A value that is not an integer list fails the check below
  // rather than being coerced into one.
  const close = body.indexOf("]", open);
  if (close === -1) return null;

  try {
    const parsed: unknown = JSON.parse(body.slice(open, close + 1));
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every((n) => Number.isInteger(n))) return null;
    return parsed as number[];
  } catch {
    return null;
  }
}

function readAnswer(body: string): string {
  const key = body.indexOf(ANSWER_KEY);
  if (key === -1) return "";

  const open = body.indexOf('"', key + ANSWER_KEY.length);
  if (open === -1) return "";

  let out = "";
  for (let i = open + 1; i < body.length; i += 1) {
    const char = body[i]!;
    if (char === '"') break;
    if (char !== "\\") {
      out += char;
      continue;
    }

    const escaped = body[i + 1];
    // The backslash is the last thing to arrive: hold it rather than emit it.
    if (escaped === undefined) break;

    if (escaped === "u") {
      const hex = body.slice(i + 2, i + 6);
      if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 5;
      continue;
    }

    out += UNESCAPE[escaped] ?? escaped;
    i += 1;
  }

  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- --test-name-pattern="readPartial"` then `npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/server/ai/partialJson.ts test/partialJson.test.ts
git commit -m "feat(ai): read citations and prose out of half-arrived JSON"
```

---

### Task 2: `createRestorer` — put names back without splitting a placeholder

**Files:**
- Create: `src/server/privacy/restoreStream.ts`
- Test: `test/restoreStream.test.ts`

**Interfaces:**
- Consumes: `Anonymizer.restore(text: string): string` from `src/server/privacy/anonymizer.ts`, passed in as a parameter.
- Produces: `createRestorer(restore: (text: string) => string): { push(delta: string): string; flush(): string }`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRestorer } from "@/server/privacy/restoreStream";

/** Stands in for the real anonymizer's mapping. */
const restore = (text: string) => text.replaceAll("[PERSON_1]", "Marek Dvořák");

describe("createRestorer", () => {
  it("restores a placeholder that arrives whole", () => {
    const r = createRestorer(restore);
    assert.equal(r.push("hi [PERSON_1] there"), "hi Marek Dvořák there");
    assert.equal(r.flush(), "");
  });

  it("restores a placeholder split across every internal boundary", () => {
    const whole = "before [PERSON_1] after";
    for (let cut = 0; cut < whole.length; cut += 1) {
      const r = createRestorer(restore);
      const out = r.push(whole.slice(0, cut)) + r.push(whole.slice(cut)) + r.flush();
      assert.equal(out, "before Marek Dvořák after", `split at ${cut}`);
    }
  });

  it("does not hold text back forever for a bracket that is not a placeholder", () => {
    const r = createRestorer(restore);
    const out = r.push("see [1] and a lot more text after it that should not be held");
    assert.match(out, /should not be held/);
  });

  it("emits a trailing unterminated bracket on flush", () => {
    const r = createRestorer(restore);
    assert.equal(r.push("ends with ["), "ends with ");
    assert.equal(r.flush(), "[");
  });

  it("passes text with no placeholders straight through", () => {
    const r = createRestorer(restore);
    assert.equal(r.push("nothing to do here"), "nothing to do here");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- --test-name-pattern="createRestorer"`
Expected: FAIL — cannot find module `@/server/privacy/restoreStream`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Applies the anonymizer's inverse mapping to text arriving in pieces.
 *
 * `Anonymizer.restore` works on complete text. Called once per streamed delta
 * it would corrupt any placeholder that straddles a boundary: `[PERSON_` and
 * `1]` restore to neither the placeholder nor the person, and the placeholder
 * syntax — which the user should never see — leaks into the answer.
 *
 * So this holds back the shortest suffix that could still become a
 * placeholder, and releases it the moment it either closes or becomes
 * impossible. It knows nothing about the mapping itself: `restore` arrives as
 * a parameter, so the per-request mapping stays where CLAUDE.md §7 puts it.
 */

/**
 * Longer than any placeholder this app produces — `[PERSON_999]` is 12 — so a
 * `[` in ordinary prose delays at most this many characters before the text
 * is released. Without the cap, a note containing "see [1]" would stall the
 * rest of the answer until the stream ended.
 */
const LONGEST_PLACEHOLDER = 16;

export interface Restorer {
  /** Restored text safe to show now. May be empty while a suffix is held. */
  push(delta: string): string;
  /** Whatever was still held when the stream ended. */
  flush(): string;
}

export function createRestorer(restore: (text: string) => string): Restorer {
  let held = "";

  return {
    push(delta: string): string {
      const text = held + delta;

      const open = text.lastIndexOf("[");
      const unterminated =
        open !== -1 &&
        !text.slice(open).includes("]") &&
        text.length - open <= LONGEST_PLACEHOLDER;

      const cut = unterminated ? open : text.length;
      held = text.slice(cut);

      return restore(text.slice(0, cut));
    },

    flush(): string {
      const rest = held;
      held = "";
      return restore(rest);
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- --test-name-pattern="createRestorer"` then `npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/server/privacy/restoreStream.ts test/restoreStream.test.ts
git commit -m "feat(privacy): restore placeholders across streamed deltas"
```

---

### Task 3: The seam gains an optional stream, and the mock implements it

**Files:**
- Modify: `src/server/ai/types.ts`
- Modify: `src/server/ai/providers/mock.ts`
- Test: `test/mock-stream.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `AnswerStreamEvent`; `LlmProvider.answerStream?(input, signal): AsyncIterable<AnswerStreamEvent>`; the mock implements it.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- --test-name-pattern="mock answerStream"`
Expected: FAIL — `provider.answerStream` is undefined.

- [ ] **Step 3: Add the types**

In `src/server/ai/types.ts`, after `AnswerResult`:

```ts
/**
 * One event from a provider that can answer incrementally.
 *
 * `citations` comes FIRST, which is the whole point: the guard in
 * rag/answer.ts can then run before a word of prose is shown, so an answer
 * that cites nothing valid is refused without the user having read it. The
 * prompt asks the model for that field order and `ai/partialJson.ts` reads it
 * out of the response as it arrives.
 *
 * `usage` arrives last, because token counts are only final when the call is.
 */
export type AnswerStreamEvent =
  | { type: "citations"; citations: number[] }
  | { type: "delta"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number };
```

and inside `LlmProvider`, after `answer`:

```ts
  /**
   * Optional, and absence is not a defect: a provider without this is called
   * through `answer` and its whole reply is emitted as one delta, so nothing
   * above `providers/` has a second code path. Implemented where it has been
   * exercised against a live service — see README gaps 1 and 2 for why that
   * excludes the vendor and the gateway stub.
   */
  answerStream?(
    input: AnswerInput,
    signal: AbortSignal,
  ): AsyncIterable<AnswerStreamEvent>;
```

- [ ] **Step 4: Refactor the mock so both entry points share one computation**

In `src/server/ai/providers/mock.ts`, extract the existing body of `answer` into a module-level function, leaving behaviour identical:

```ts
/** The whole answer, computed once. Both entry points below use it. */
function extract(input: AnswerInput): AnswerResult {
  // ...the existing body of `answer`, unchanged, returning the same object...
}
```

then replace the returned object with:

```ts
  return {
    name: "mock",
    model: "mock-extractive-v1",

    async answer(input: AnswerInput): Promise<AnswerResult> {
      return extract(input);
    },

    async *answerStream(input: AnswerInput): AsyncGenerator<AnswerStreamEvent> {
      const result = extract(input);

      yield { type: "citations", citations: result.citations };

      // Sentence at a time, which is the granularity this provider has: it
      // extracts whole sentences, so anything finer would be a pretence at
      // generation. No artificial delay either — a mock that fakes latency to
      // look good in a demo is a lie in the one provider that exists to be
      // honest and deterministic.
      // Splits AFTER the whitespace following a sentence end, so every
      // character lands in exactly one delta and the joined deltas equal
      // `result.answer` byte for byte. The test asserts that: a streaming path
      // that quietly drops a space between sentences shows a different answer
      // than the one the guard approved.
      for (const piece of result.answer.split(/(?<=[.!?]\s)/)) {
        if (piece.length > 0) yield { type: "delta", text: piece };
      }

      yield {
        type: "usage",
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      };
    },
  };
```

- [ ] **Step 5: Run the tests**

Run: `npm test` then `npm run typecheck`
Expected: PASS — including the existing mock-driven tests, unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/server/ai/types.ts src/server/ai/providers/mock.ts test/mock-stream.test.ts
git commit -m "feat(ai): add an optional streaming method to the provider seam"
```

---

### Task 4: `askQuestionStream` becomes the single implementation

**Files:**
- Modify: `src/server/rag/answer.ts`
- Test: `test/answer.test.ts` (extend; existing tests unchanged)

**Interfaces:**
- Consumes: `createRestorer` (Task 2), `AnswerStreamEvent` (Task 3), existing `resolveCitations`, `reserveCall`, `recordTokens`.
- Produces: `askQuestionStream(ownerSub, question, deps?): AsyncGenerator<AskEvent>`; `AskEvent`; `askQuestion` unchanged in signature and return type; `AskDependencies.answerStream?`.

- [ ] **Step 1: Write the failing tests** (append to `test/answer.test.ts`)

```ts
import type { AnswerStreamEvent } from "@/server/ai/types";
import { askQuestionStream, type AskEvent } from "@/server/rag/answer";

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

describe("askQuestionStream", () => {
  it("never emits a delta before the citations that justify it", async () => {
    const model = stubStream([1], ["750 ", "W."]);
    const events = await collectEvents(
      askQuestionStream("alice", "how big is the PSU?", {
        ...deps(sources, { answer: async () => { throw new Error("unused"); } }),
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
        ...deps(sources, { answer: async () => { throw new Error("unused"); } }),
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
        ...deps(sources, { answer: async () => { throw new Error("unused"); } }),
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
        ...deps(sources, { answer: async () => { throw new Error("unused"); } }),
        answerStream: () => model(),
      }),
    );

    assert.equal(events[0]?.type, "privacy");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test -- --test-name-pattern="askQuestionStream"`
Expected: FAIL — `askQuestionStream` is not exported.

- [ ] **Step 3: Restructure `src/server/rag/answer.ts`**

Add the event type beside `AskResult`, keeping `AskResult` exactly as it is:

```ts
/**
 * What the streaming path emits, in the order it emits it.
 *
 * The ORDER is the contract, not a convenience: `citations` is emitted before
 * the first `delta` and only after `resolveCitations` has accepted them, so a
 * consumer that ignored every other rule still cannot render prose that has no
 * validated source. That is CLAUDE.md §6 living in the protocol rather than in
 * the UI's good intentions.
 *
 * `citations` is held until the first non-empty delta, because the guard has
 * two halves — citations resolve AND the answer is non-empty — and the second
 * cannot be known before prose exists. A model that cites correctly and says
 * nothing is refused, having shown nothing.
 */
export type AskEvent =
  | { type: "privacy"; privacy: Privacy }
  | { type: "citations"; citations: Citation[] }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "not_found"; reason: "no_relevant_chunks" | "citations_rejected" }
  | {
      type: "budget_exhausted";
      scope: SpendScope;
      retryAfterSeconds: number;
    };
```

Add the optional dependency to `AskDependencies`, documented beside the existing `answer`:

```ts
  /**
   * Present when the provider can stream. Absent is not a defect: the
   * orchestrator falls back to `answer` and emits the whole reply as one
   * delta, so there is one code path here regardless.
   */
  answerStream?: (input: AnswerInput) => AsyncIterable<AnswerStreamEvent>;
```

`LIVE` is **not** changed in this task. It keeps only `answer`, so the live path runs through
`oneShot` below and behaves exactly as it does today — one delta carrying the whole answer.
Task 5 builds the audited streaming wrapper and adds the `answerStream` line to `LIVE` then.
The ordering is deliberate: this task is a restructuring that must be provably
behaviour-preserving, which is easiest to show when the live path has not moved.

Add the adapter that removes the second code path:

```ts
/**
 * A non-streaming provider, shaped like a streaming one.
 *
 * This is what keeps `anthropic` and `gateway` — and every stub in the tests
 * that returns a whole answer — on the same path as `mock` and `openrouter`.
 * One await, then the same three events in the same order.
 */
async function* oneShot(
  answer: Promise<AnswerResult>,
): AsyncGenerator<AnswerStreamEvent> {
  const result = await answer;
  yield { type: "citations", citations: result.citations };
  yield { type: "delta", text: result.answer };
  yield {
    type: "usage",
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  };
}
```

Convert `askQuestion` into a generator plus a collector. The generator is the existing function with the model call replaced by a loop over events; every log line, refusal reason and retry rule moves across unchanged:

```ts
export async function* askQuestionStream(
  ownerSub: string,
  question: string,
  deps: AskDependencies = LIVE,
): AsyncGenerator<AskEvent> {
  const retrieved = await deps.retrieve(ownerSub, question);

  if (retrieved.length === 0) {
    logger.info({ sub: ownerSub, outcome: "no_relevant_chunks" }, "ask");
    yield { type: "not_found", reason: "no_relevant_chunks" };
    return;
  }

  const anonymizer = createAnonymizer(getPersonDetector());
  const redactedQuestion = await anonymizer.redact(question);
  const chunks: AnswerInput["chunks"] = [];
  for (const chunk of retrieved) {
    chunks.push({
      id: chunk.id,
      documentId: chunk.documentId,
      content: await anonymizer.redact(chunk.content),
    });
  }
  const input = { question: redactedQuestion, chunks };
  const privacy: Privacy = { redactedQuestion, replaced: anonymizer.counts() };

  yield { type: "privacy", privacy };

  for (const retry of [false, true]) {
    const reservation = await deps.reserveCall(ownerSub);

    if (!reservation.allowed) {
      if (retry) {
        logger.warn(
          { sub: ownerSub, scope: reservation.scope, outcome: "retry_unfunded" },
          "ask",
        );
        break;
      }

      logger.warn(
        { sub: ownerSub, scope: reservation.scope, outcome: "budget_exhausted" },
        "ask",
      );
      yield {
        type: "budget_exhausted",
        scope: reservation.scope,
        retryAfterSeconds: reservation.retryAfterSeconds,
      };
      return;
    }

    const attempt = { ...input, retry };
    const stream = deps.answerStream
      ? deps.answerStream(attempt)
      : oneShot(deps.answer(attempt));

    // Everything the guard needs, accumulated as the stream arrives.
    let citations: Citation[] = [];
    let returnedCitations = 0;
    let usage = { inputTokens: 0, outputTokens: 0 };
    let emittedCitations = false;
    let emittedText = false;
    const restorer = createRestorer((text) => anonymizer.restore(text));

    for await (const event of stream) {
      if (event.type === "usage") {
        usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
        continue;
      }

      if (event.type === "citations") {
        returnedCitations = event.citations.length;
        citations = resolveCitations(event.citations, retrieved);
        // Nothing is emitted here. An invalid set means this attempt is over,
        // and the user has been shown nothing to take back.
        if (citations.length === 0) break;
        continue;
      }

      // A delta before any citations event, or after a rejected one, is prose
      // with nothing to justify it. Dropped rather than shown.
      if (citations.length === 0) continue;

      const text = restorer.push(event.text);
      if (text.length === 0) continue;

      if (!emittedCitations && text.trim().length > 0) {
        yield { type: "citations", citations };
        emittedCitations = true;
      }

      if (emittedCitations) {
        emittedText = true;
        yield { type: "delta", text };
      }
    }

    const tail = restorer.flush();
    if (emittedCitations && tail.length > 0) yield { type: "delta", text: tail };

    await deps.recordTokens(ownerSub, usage.inputTokens, usage.outputTokens);

    if (emittedCitations && emittedText) {
      logger.info(
        {
          sub: ownerSub,
          outcome: "answered",
          retried: retry,
          chunksRetrieved: retrieved.length,
          lexicalHits: retrieved.filter((c) =>
            c.matchedBy.some((arm) => arm !== "vector"),
          ).length,
          citationCount: citations.length,
          topScore: Number(retrieved[0]!.score.toFixed(3)),
          redacted: privacy.replaced,
        },
        "ask",
      );
      yield { type: "done" };
      return;
    }

    logger.warn(
      {
        sub: ownerSub,
        retried: retry,
        returnedCitations,
        validCitations: citations.length,
      },
      "answer rejected by citation guard",
    );
  }

  logger.info({ sub: ownerSub, outcome: "citations_rejected" }, "ask");
  yield { type: "not_found", reason: "citations_rejected" };
}
```

Then the collector, which is what every existing caller and test keeps using:

```ts
/**
 * The whole answer, for callers that cannot stream — the tests, and any future
 * non-HTTP entry point.
 *
 * It is a collector over `askQuestionStream` and NOT a second implementation.
 * The citation guard exists once in this file; a copy of it here would be the
 * one duplication this project cannot afford, because the two would drift and
 * the promise in CLAUDE.md §6 is only as good as its least careful copy.
 */
export async function askQuestion(
  ownerSub: string,
  question: string,
  deps: AskDependencies = LIVE,
): Promise<AskResult> {
  let privacy: Privacy | null = null;
  let citations: Citation[] = [];
  let answer = "";

  for await (const event of askQuestionStream(ownerSub, question, deps)) {
    switch (event.type) {
      case "privacy":
        privacy = event.privacy;
        break;
      case "citations":
        citations = event.citations;
        break;
      case "delta":
        answer += event.text;
        break;
      case "not_found":
        return { status: "not_found", reason: event.reason };
      case "budget_exhausted":
        return {
          status: "budget_exhausted",
          scope: event.scope,
          retryAfterSeconds: event.retryAfterSeconds,
        };
      case "done":
        break;
    }
  }

  return { status: "answered", answer, citations, privacy: privacy! };
}
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test` then `npm run typecheck`
Expected: PASS — the new streaming tests AND every pre-existing `askQuestion` test, whose assertions were not touched. If an existing assertion had to change, stop: the restructuring altered behaviour and that is the thing this task must not do.

- [ ] **Step 5: Commit**

```bash
git add src/server/rag/answer.ts test/answer.test.ts
git commit -m "refactor(rag): make the streaming path the only citation guard"
```

---

### Task 5: The audit record learns time-to-first-token

**Files:**
- Modify: `src/server/db/schema.ts`
- Create: `src/server/db/migrations/0008_llm_calls_first_token.sql`
- Modify: `src/server/log/llmAudit.ts`
- Modify: `src/server/ai/call.ts`

**Interfaces:**
- Consumes: `AnswerStreamEvent` (Task 3).
- Produces: `answerStreamWithAudit(provider: LlmProvider, input: AnswerInput): AsyncGenerator<AnswerStreamEvent>` — used by `LIVE` in Task 4.

- [ ] **Step 1: Add the column to the schema**

In `src/server/db/schema.ts`, inside `llmCalls`, after `latencyMs`:

```ts
    /**
     * Time to the FIRST token, for a streaming call. Null for a provider that
     * does not stream — such a call has no first-token moment, and a zero
     * would claim it had one. A duration, not content, so §3 holds.
     */
    firstTokenMs: integer("first_token_ms"),
```

- [ ] **Step 2: Write the migration**

`src/server/db/migrations/0008_llm_calls_first_token.sql`:

```sql
ALTER TABLE "llm_calls" ADD COLUMN "first_token_ms" integer;
```

- [ ] **Step 3: Widen the audit record type**

In `src/server/log/llmAudit.ts`, add to `LlmAuditRecord`:

```ts
  /** Only a streaming call has one. Omitted otherwise — never zero. */
  firstTokenMs?: number;
```

- [ ] **Step 4: Add the streaming wrapper**

In `src/server/ai/call.ts`, beside `answerWithAudit`:

```ts
/**
 * The same door out, for a call that arrives in pieces.
 *
 * It exists so that streaming does not become a way around the wrapper
 * CLAUDE.md §5 asks for: the audit row and the timeout live here for a
 * streaming call exactly as they do for a whole one. What differs is when the
 * numbers are known — usage arrives in the last event, and latency is measured
 * to the last token rather than to a returned promise.
 */
export async function* answerStreamWithAudit(
  provider: LlmProvider,
  input: AnswerInput,
): AsyncGenerator<AnswerStreamEvent> {
  const startedAt = Date.now();
  const signal = AbortSignal.timeout(env.LLM_TIMEOUT_MS);

  let firstTokenMs: number | undefined;
  let usage = { inputTokens: 0, outputTokens: 0 };

  try {
    // Falls back to the whole-answer call when the provider cannot stream, so
    // this wrapper is the one door regardless of which providers can.
    const stream = provider.answerStream
      ? provider.answerStream(input, signal)
      : oneShotFromAnswer(provider, input, signal);

    for await (const event of stream) {
      if (event.type === "delta" && firstTokenMs === undefined) {
        firstTokenMs = Date.now() - startedAt;
      }
      if (event.type === "usage") {
        usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
      }
      yield event;
    }

    await recordLlmCall({
      provider: provider.name,
      model: provider.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      latencyMs: Date.now() - startedAt,
      firstTokenMs,
      outcome: "ok",
    });

    logger.info(
      {
        audit: "llm_call",
        provider: provider.name,
        model: provider.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        latencyMs: Date.now() - startedAt,
        firstTokenMs,
        outcome: "ok",
      },
      "llm call",
    );
  } catch (error) {
    const outcome = signal.aborted ? "timeout" : "error";

    await recordLlmCall({
      provider: provider.name,
      model: provider.model,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - startedAt,
      firstTokenMs,
      outcome,
    });

    logger.warn(
      {
        audit: "llm_call",
        provider: provider.name,
        model: provider.model,
        latencyMs: Date.now() - startedAt,
        firstTokenMs,
        outcome,
        errorType: error instanceof Error ? error.name : "unknown",
      },
      "llm call failed",
    );

    throw error;
  }
}

/**
 * A provider without `answerStream`, shaped like one that has it.
 *
 * NOT a duplicate of `oneShot` in rag/answer.ts, though it emits the same three
 * events: that one adapts an injected DEPENDENCY, so a test can drive the
 * orchestrator with a whole-answer stub and no provider at all, while this one
 * adapts a PROVIDER, so `anthropic` and `gateway` reach the audit wrapper
 * unchanged. They sit on opposite sides of the seam; neither can serve the
 * other's caller.
 */
async function* oneShotFromAnswer(
  provider: LlmProvider,
  input: AnswerInput,
  signal: AbortSignal,
): AsyncGenerator<AnswerStreamEvent> {
  const result = await provider.answer(input, signal);
  yield { type: "citations", citations: result.citations };
  yield { type: "delta", text: result.answer };
  yield {
    type: "usage",
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  };
}
```

- [ ] **Step 5: Put the live path onto the streaming wrapper**

In `src/server/rag/answer.ts`, add the line Task 4 deliberately left out:

```ts
const LIVE: AskDependencies = {
  retrieve: retrieveChunks,
  answer: (input) => answerWithAudit(getLlmProvider(), input),
  answerStream: (input) => answerStreamWithAudit(getLlmProvider(), input),
  reserveCall,
  recordTokens,
};
```

`answer` stays: the collector's stubs and any future non-streaming caller still use it.

- [ ] **Step 6: Verify**

Run: `npm test` then `npm run typecheck`
Expected: PASS, clean. (`recordLlmCall` inserts the new optional field; Drizzle omits an undefined column.)

- [ ] **Step 7: Commit**

```bash
git add src/server/db/schema.ts src/server/db/migrations/0008_llm_calls_first_token.sql src/server/log/llmAudit.ts src/server/ai/call.ts src/server/rag/answer.ts
git commit -m "feat(audit): record time to first token for streaming calls"
```

---

### Task 6: The route streams NDJSON

**Files:**
- Modify: `src/app/api/ask/route.ts`

**Interfaces:**
- Consumes: `askQuestionStream` (Task 4).
- Produces: `POST /api/ask` returning `application/x-ndjson`.

- [ ] **Step 1: Replace the single JSON response with a stream**

Keep everything before the call — `requireUser`, `consumeAskQuota`, `checkDailySpend`, `askSchema` — exactly as it is. A refusal reached before the model is still an ordinary JSON error with its status code, because a 429 is not a stream. Replace only the tail:

```ts
    const encoder = new TextEncoder();

    /**
     * NDJSON: one event per line. Not SSE, which is shaped for GET and brings
     * reconnect semantics this endpoint must not have — a reconnect would mean
     * a second charged model call for a question already asked.
     *
     * The stream opens only once every refusal that can be decided up front has
     * been decided, so a status code still carries what a status code should.
     */
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const event of askQuestionStream(sub, parsed.data.question)) {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          }
        } catch (error) {
          // The connection is already open with a 200, so this cannot become a
          // status code. It becomes the terminal event the protocol defines for
          // exactly this, and the log line keeps the cause.
          logger.error({ err: error, sub }, "ask stream failed");
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: "error" })}\n`));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        // Nothing here is cacheable and a proxy buffering it would undo the
        // whole feature.
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
```

- [ ] **Step 2: Verify the guard order is untouched**

Read the file top to bottom and confirm: `requireUser` still runs first and its `sub` is still the only thing that decides whose documents are searched; the rate limit still runs before the body is read; the daily pre-check still returns 429 with `retry-after`.

- [ ] **Step 3: Run**

Run: `npm test` then `npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/ask/route.ts
git commit -m "feat(ask): stream the answer as NDJSON"
```

---

### Task 7: The UI reads the stream

**Files:**
- Modify: `src/app/ask/ask-form.tsx`

**Interfaces:**
- Consumes: the NDJSON protocol from Task 6.
- Produces: no exports beyond the existing `AskForm`.

- [ ] **Step 1: Replace the single-response read with a line reader**

Replace the `AskResult` type with the event union and the state it drives:

```tsx
type AskEvent =
  | { type: "privacy"; privacy: Privacy }
  | { type: "citations"; citations: Citation[] }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "not_found"; reason: string }
  | { type: "budget_exhausted"; scope: string; retryAfterSeconds: number }
  | { type: "error" };
```

and the reader, which is the thirty lines CLAUDE.md §8 says not to add a dependency for:

```tsx
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // A chunk can split a line anywhere, so the last piece is kept until
        // its newline arrives.
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.trim().length === 0) continue;
          handle(JSON.parse(line) as AskEvent);
        }
      }
```

- [ ] **Step 2: Drive four states from the events**

State: `privacy`, `citations`, `answer` (accumulated), `outcome` (`null | "done" | "not_found" | "budget" | "error"`), plus the existing `pending`.

`handle` appends `delta` text to `answer`, sets `citations` on the citations event, and sets `outcome` on any terminal event. Render rules:

- `pending && citations === null && answer === ""` → **"Checking sources…"**. This is the state a rejected answer never leaves, which is the point of the whole slice.
- `citations !== null` → render the sources list first, then the accumulated `answer` below it, growing.
- `outcome === "not_found"` → the existing amber panel and copy, unchanged, including `NOT_FOUND_MESSAGE`.
- `outcome === "budget_exhausted"` → the same message the 429 path shows.
- `outcome === "error" && citations !== null` → keep the partial answer and its sources, and add: *"The connection dropped before the answer finished."*
- `outcome === "error" && citations === null` → the generic failure message.

- [ ] **Step 3: Check it by eye**

Run: `npm run build`
Expected: clean build. Visual confirmation happens in Task 10 against the running stack.

- [ ] **Step 4: Commit**

```bash
git add src/app/ask/ask-form.tsx
git commit -m "feat(ask): show sources first, then the answer as it arrives"
```

---

### Task 8: Ask the model for citations first

**Files:**
- Modify: `prompts/answer-system.md`
- Modify: `src/server/ai/providers/schema.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a JSON contract whose first key is `citations`.

- [ ] **Step 1: Reorder the contract in the prompt**

In `prompts/answer-system.md`, replace the JSON example and the sentence after it:

```
Return JSON, and nothing else — no prose before it, no code fence around it. The keys must
appear in this order, `citations` first:

{"citations": [<source numbers you used>], "answer": "<your answer>"}

`citations` is a list of integers, and every one of them must be the `index` of a `<source>`
shown below. It comes first because the application checks your sources before it shows your
answer to anyone: decide what you are citing, then write from those sources.
If the sources do not answer the question, return an empty list: `{"citations": [], "answer": "..."}`.
```

Also reorder rule 3 and rule 4's examples to match. Do not change any other rule: the injection envelope rules in 1 and 2 are load-bearing and out of scope here.

- [ ] **Step 2: Reorder the zod schema to match**

In `src/server/ai/providers/schema.ts`, put `citations` before `answer` in the object, and add:

```ts
/**
 * `citations` is declared FIRST, and that order is not cosmetic: it is the
 * order the prompt asks the model for and the order `structuredOutputs`
 * advertises to a server that enforces the schema. The streaming path can then
 * run the citation guard before any prose is shown. A model that ignores the
 * order still parses correctly — it just cannot be streamed early.
 */
```

- [ ] **Step 3: Run the prompt tests**

Run: `npm test -- --test-name-pattern="prompt"` then `npm test`
Expected: PASS. `test/prompt-envelope.test.ts` asserts against prompt text, so read its failures carefully rather than adjusting assertions to fit: if it fails, decide whether the prompt edit broke the envelope or merely moved text the test pinned.

- [ ] **Step 4: Commit**

```bash
git add prompts/answer-system.md src/server/ai/providers/schema.ts
git commit -m "feat(prompts): ask for citations before the answer"
```

---

### Task 9: OpenRouter streams

**Files:**
- Modify: `src/server/ai/providers/messages.ts`
- Modify: `src/server/ai/providers/openrouter.ts`
- Modify: `src/server/ai/providers/anthropic.ts`
- Modify: `src/server/ai/providers/gateway.ts`

**Interfaces:**
- Consumes: `readPartial` (Task 1), `AnswerStreamEvent` (Task 3).
- Produces: `MessagesProviderOptions.streaming: boolean`; `answerStream` present only when it is true.

- [ ] **Step 1: Add the option**

In `src/server/ai/providers/messages.ts`, extend `MessagesProviderOptions`:

```ts
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
```

- [ ] **Step 2: Implement the streaming call**

In the same file, inside `createMessagesProvider`, build the provider object and attach `answerStream` conditionally:

```ts
  const provider: LlmProvider = {
    name,
    model: env.LLM_MODEL,
    async answer(input, signal) { /* unchanged */ },
  };

  if (!options.streaming) return provider;

  return {
    ...provider,
    async *answerStream(
      input: AnswerInput,
      signal: AbortSignal,
    ): AsyncGenerator<AnswerStreamEvent> {
      const { system, user } = renderAnswerPrompt(input);

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

      let accumulated = "";
      let sentCitations = false;
      let sentUpTo = 0;

      for await (const event of stream) {
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
        // guard has not seen.
        if (citations === null) continue;

        if (!sentCitations) {
          yield { type: "citations", citations };
          sentCitations = true;
        }

        if (answerSoFar.length > sentUpTo) {
          yield { type: "delta", text: answerSoFar.slice(sentUpTo) };
          sentUpTo = answerSoFar.length;
        }
      }

      const final = await stream.finalMessage();

      // A model that put `answer` before `citations`, or wrapped the object in
      // prose, reaches here having streamed nothing. That is the degradation
      // the design accepts: the whole reply is emitted at the end, so field
      // order costs latency and never correctness.
      if (!sentCitations) {
        const parsed =
          (final.parsed_output as AnswerJson | null | undefined) ??
          parseFromText(final.content);

        if (!parsed) {
          throw new Error(
            `Model returned no parseable answer (stop_reason: ${final.stop_reason})`,
          );
        }

        yield { type: "citations", citations: parsed.citations };
        yield { type: "delta", text: parsed.answer };
      }

      yield {
        type: "usage",
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
      };
    },
  };
```

- [ ] **Step 3: Set the flag at each call site**

- `openrouter.ts`: `createMessagesProvider("openrouter", client, { structuredOutputs: false, streaming: true })`
- `anthropic.ts`: add `streaming: false`
- `gateway.ts`: add `streaming: false`

- [ ] **Step 4: Run**

Run: `npm test` then `npm run typecheck`
Expected: PASS — including `test/gateway.test.ts`, which pins the gateway's request and must be unaffected because the gateway does not stream.

- [ ] **Step 5: Commit**

```bash
git add src/server/ai/providers/
git commit -m "feat(openrouter): stream the answer, citations first"
```

---

### Task 10: Measure it, and let the measurement veto the slice

**Files:**
- Modify: `README.md`
- Modify: `docs/decisions.md`

This task is the one that decides whether the previous nine ship. Do not skip a number because it is inconvenient.

- [ ] **Step 1: Bring up the stack**

```bash
docker compose up -d --build
until curl -sf http://localhost:3000/api/health >/dev/null; do sleep 2; done
```

- [ ] **Step 2: Measure citation quality, before and after**

This is the veto. Ask the seed corpus's demo questions through `LLM_PROVIDER=openrouter`, on this branch and on `main`, and record for each: whether the answer was shipped or refused, and whether the cited sources are the right ones. The rejection rate and the cited-source correctness are the two numbers.

```bash
docker compose logs app | grep '"msg":"ask"' | grep -o '"outcome":"[a-z_]*"' | sort | uniq -c
docker compose logs app | grep -c "answer rejected by citation guard"
```

**If citation quality is worse on this branch, the slice does not land.** Latency is not worth trading the one functional promise for. Record the numbers in the README either way and stop here for a decision.

- [ ] **Step 3: Measure what the slice was for**

```bash
docker compose logs app | grep '"audit":"llm_call"' | tail -5
```

Record `firstTokenMs` against `latencyMs` for the same questions, and compare `latencyMs` with the same questions on `main`. Time-to-first-token versus time-to-answer is the headline number.

- [ ] **Step 4: Measure field-order compliance**

Count how often `citations` completed before the prose began — that is, how often `firstTokenMs` is present and well under `latencyMs`, versus how often the whole reply arrived at the end. Report the rate. If the model never complies, say so plainly: the feature degrades to non-streaming and the README must not imply otherwise.

- [ ] **Step 5: Demonstrate the guarantee in the running app**

- Ask a question that answers → sources appear, then prose grows beneath them.
- Ask a question the corpus cannot answer → "Checking sources…" then the refusal, with no prose ever shown.
- `LLM_PROVIDER=mock docker compose up` → streams with no key set (CLAUDE.md §5).
- Check the audit table carries `first_token_ms` and still no content:

```bash
docker compose exec db psql -U postgres -d pkb -c "select provider, model, input_tokens, output_tokens, latency_ms, first_token_ms, outcome from llm_calls order by created_at desc limit 5;"
```

- [ ] **Step 6: Write the README section and the gaps**

Add a *Streaming* subsection under the retrieval/answering material covering: the citations-first contract and why, the protocol's ordering rule as the guarantee, the measured numbers from steps 2–4, and that `anthropic` and `gateway` do not stream. Add the four gaps from spec §14, plus any the measurement discovered. Move the *Streaming answers* item out of *What I would build next* and correct anything that item claimed which turned out wrong — the way slices 13, 15 and 16 each did.

- [ ] **Step 7: Write the decisions entries**

One line each, in the file's existing format, for: citations-before-answer and what it rejected; NDJSON over SSE; the collector rather than a second guard; streaming enabled only for `openrouter`; lazy citation emission on first non-empty delta.

- [ ] **Step 8: Commit**

```bash
git add README.md docs/decisions.md
git commit -m "docs: record streaming answers, and what the measurement showed"
```
