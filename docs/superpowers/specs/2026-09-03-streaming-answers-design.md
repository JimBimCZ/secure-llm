# Slice 18 — streaming answers, without loosening the citation guarantee

The README's *What I would build next* has carried this item since slice 6: *"Streaming answers.
Currently the user waits for the whole response. The citation guard has to run on a complete
answer, so this needs care: stream the text, hold the sources until the guard has passed."*

That sentence contains the whole problem and, on inspection, the wrong solution. This spec keeps
the problem and changes the solution.

## 1. Which hard requirement this serves

CLAUDE.md §6: **an answer without a source is not shipped.** Streaming is the first feature in
this project that can weaken that promise by accident, because it puts text in front of a user
before the guard that validates it has run. The requirement is therefore not "add streaming" but
"add streaming and be able to show the guarantee is exactly as strong afterwards".

Nothing else in §3 changes. Ownership filtering, the two ceilings, the audit record's contents,
the anonymizer's request-lifetime mapping: all untouched, and §11 below says how each is shown to
be untouched.

## 2. The conflict, stated exactly

`rag/answer.ts` decides between `answered` and `not_found` only after a complete
`{ answer, citations }` comes back: `resolveCitations` needs the full citation array, and one
stricter retry is allowed after a rejection. So at the moment the first token of prose exists,
the verdict does not.

The README's own phrasing — "stream the text, hold the sources" — resolves this by showing prose
whose validity is still unknown and retracting it if the guard rejects. The letter of §6 survives
(no citation is ever rendered unvalidated) but the reader has still watched the app produce an
answer it then takes back, and the retraction is silent.

## 3. The decision: nothing unvalidated is ever visible

**`citations` moves ahead of `answer` in the model's JSON contract.** The orchestrator parses the
citation array out of the partial response as soon as it is complete, runs the existing guard on
it, and only then begins emitting prose. A rejection therefore happens while the UI is still
showing "checking sources…", and the user never sees a word of an answer that fails.

This is a stronger position than the app holds today, not merely an equal one: today a rejected
answer is computed in full before it is discarded, and the user waits for it. Here the rejection
is reached at the citation array, before the prose is streamed.

The cost is a new dependency on the model emitting fields in the order the schema and prompt ask
for. §8 shows why that dependency cannot break correctness, only latency.

## 4. The protocol

The route keeps `POST /api/ask` and streams **NDJSON** — one JSON object per line, read on the
client with `response.body.getReader()`.

```
{"type":"privacy","redactedQuestion":"…","replaced":{"persons":2,"emails":0,"phones":0}}
{"type":"citations","citations":[{…Citation…}]}
{"type":"delta","text":"NVMe endurance is rated"}
{"type":"delta","text":" in TBW over the warranty…"}
{"type":"done"}
```

and the three terminal alternatives to `citations`:

```
{"type":"not_found","reason":"no_relevant_chunks"|"citations_rejected"}
{"type":"budget_exhausted","scope":"user"|"deployment","retryAfterSeconds":n}
{"type":"error"}
```

Rules the protocol carries, so that no consumer has to be trusted with them:

- **A `delta` never precedes `citations`.** This is §6 expressed in the wire format. A client that
  ignored every other rule still cannot render prose that has no validated source.
- `privacy` is emitted before the model call, because its counts are known once the question and
  chunks are redacted, and the UI's redaction badge is then correct from the first frame.
- `error` after `citations` means the stream broke mid-prose. The answer stands with its sources,
  marked incomplete. `error` before `citations` is a failed question and shows the refusal.
- Exactly one terminal event per response: `done`, `not_found`, `budget_exhausted`, or `error`.

NDJSON rather than SSE: SSE is shaped for GET and carries reconnect semantics (`Last-Event-ID`,
retry intervals) that this endpoint would have to explain away, since a reconnect would mean a
second charged model call. A streamed response body has none of that.

## 5. One guard, one code path

`askQuestionStream(ownerSub, question, deps)` becomes an async generator and **the single
implementation**. `askQuestion` is rewritten as a thin collector that drains it into today's
`AskResult`.

This is the load-bearing structural decision. A streaming path beside the existing one would mean
two copies of the citation guard, and the guard is the one thing in this project that must not
exist twice. The collector also keeps every existing test in `test/answer.test.ts` meaningful
against unchanged assertions.

Its consequence for providers: **a provider that cannot stream produces exactly one `delta`.** The
route, the protocol, and the UI have one path each; only granularity differs between `mock` and
`anthropic`.

## 6. The seam

`LlmProvider` gains one optional method. `answer` stays required and unchanged.

```ts
export type AnswerStreamEvent =
  | { type: "citations"; citations: number[] }
  | { type: "delta"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number };

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  answer(input: AnswerInput, signal: AbortSignal): Promise<AnswerResult>;
  /** Implemented by providers that can stream. Absent is not a defect. */
  answerStream?(input: AnswerInput, signal: AbortSignal): AsyncIterable<AnswerStreamEvent>;
}
```

`mock` and `openrouter` implement it. `anthropic` and `gateway` do not, and keep the call they
have. That is a deliberate refusal to write streaming code for two endpoints this project has
never run against a live service (README gaps 1 and 2): streaming is precisely the kind of
behaviour — event framing, partial JSON, usage placement, abort handling — that a wire format
document tells you least about. Adding it unexercised would put verification-by-construction on
the seam CLAUDE.md §5 calls the most important in the project, on the day it also changes shape.

`citations` in `AnswerStreamEvent` stays a `number[]` of 1-based positions, for the reason
`ai/types.ts` already gives: the model never sees a chunk id, so it cannot invent a real one.

## 7. The two pure functions

Both are I/O-free, both are where this slice's bugs would live, and both are written test-first.

### `src/server/ai/partialJson.ts`

```ts
export function readPartial(accumulated: string): {
  citations: number[] | null;
  answerSoFar: string;
};
```

Given whatever text has arrived so far, return the citation array once it is complete, and the
decoded prefix of the `answer` string. It must handle a string value that is still open, and the
escapes that can appear inside one: `\"`, `\\`, `\n`, `\uXXXX`. A half-written escape at the end
of the buffer is held back rather than guessed at.

### `src/server/privacy/restoreStream.ts`

```ts
export function createRestorer(restore: (text: string) => string): {
  push(delta: string): string;
  flush(): string;
};
```

`Anonymizer.restore` operates on complete text. Called per delta it would corrupt any placeholder
split across a boundary: `[PERSON_` + `1]` restores to neither the placeholder nor the person, and
the placeholder syntax leaks into the UI. `push` therefore holds back the shortest suffix that
could still grow into a placeholder — from the last unmatched `[` — and releases it once the
placeholder closes or becomes impossible. `flush` emits whatever is left at the end of the stream.

The anonymizer itself is not modified: the restorer takes `restore` as a parameter, so the
per-request mapping stays exactly where §7 of CLAUDE.md puts it.

## 8. Field order cannot break correctness

If a model emits `answer` before `citations` despite the schema and the prompt, `readPartial`
simply returns `citations: null` until the whole object has arrived. The orchestrator then
validates and emits at the end, and the response degrades to a single `delta` — precisely the
non-streaming behaviour, reached without a special case.

So the new dependency introduced in §3 costs **latency, never correctness**. This is why the JSON
contract is kept rather than replaced by a line-based streaming format (see §16).

## 9. Audit, spend, timeout

`answerWithAudit` gains a streaming sibling that wraps an `AsyncIterable` rather than a promise,
and the audit record is written when the stream ends:

- `inputTokens` / `outputTokens` come from the `usage` event. A stream that ends without one
  records zeros, exactly as a failed call does today.
- `latencyMs` becomes time to **last** token. Time to first token is recorded separately as
  `firstTokenMs`, in both the table and the log line, because the whole point of the slice is a
  number today's record cannot express. It is null for a provider that does not stream, rather
  than zero: a non-streaming call has no first-token moment, and a zero would claim it had one.
  Both are durations; neither is content, so §3's rule on the audit table holds. The column is a
  migration — see §11.
- The abort signal still cancels the underlying request; a call we stopped waiting for keeps
  costing until it is aborted, and that reasoning is unchanged.

Spending is untouched. `reserveCall` still runs before the call and the retry still reserves
again, so both ceilings behave identically — the reservation is still the check.

## 10. The UI

`src/app/ask/ask-form.tsx` (client component) reads the stream and renders four states in order:
*asking* → *checking sources…* → *sources, then prose arriving* → *done*. The redaction badge
appears at the `privacy` event. On `not_found` and `budget_exhausted` the existing copy is shown
unchanged — including `NOT_FOUND_MESSAGE`, which stays one sentence with no hedging.

An `error` after citations renders the partial answer with its sources and a plain line saying the
answer was cut short. An `error` before citations renders the same refusal as any other failure.

No new dependency. `fetch` + `getReader()` + a line splitter is about thirty lines, which §8 of
CLAUDE.md says is not a reason to add a package.

## 11. What changes, file by file

### `src/server/ai/types.ts`
`AnswerStreamEvent` added; `answerStream?` added to `LlmProvider`. `AnswerResult` unchanged.

### `src/server/ai/partialJson.ts` (new)
§7. Pure, tested first.

### `src/server/privacy/restoreStream.ts` (new)
§7. Pure, tested first.

### `src/server/ai/call.ts`
`answerStreamWithAudit` added beside `answerWithAudit`, sharing the record shape. `firstTokenMs`
added to the audit record and the log line.

### `src/server/ai/providers/mock.ts`
Implements `answerStream`: emits citations, then the extracted sentences as several deltas, then
usage. No artificial delay — a mock that fakes latency to look good in a demo is a lie in the one
provider that exists to be honest and deterministic.

### `src/server/ai/providers/openrouter.ts`
Implements `answerStream` over the provider's SSE response, feeding `readPartial`.

### `src/server/ai/providers/anthropic.ts`, `gateway.ts`
Unchanged. They have no `answerStream`, and §5's one-big-delta path covers them.

### `src/server/rag/answer.ts`
`askQuestionStream` becomes the implementation; `askQuestion` becomes the collector. The guard,
the retry, the logging and the refusal reasons move as they are — this is a restructuring, not a
rewrite, and the diff should read that way.

### `src/app/api/ask/route.ts`
Returns a streamed NDJSON `Response`. The guard, the rate limit and the daily pre-check run before
the stream opens and still return ordinary JSON errors, because a 429 is not a stream.

### `prompts/answer-system.md`, `prompts/answer-user.md`, `prompts/answer-retry.md`
`citations` documented before `answer`, with the JSON example reordered to match. Whichever of
these carries the JSON shape is the one that changes; the others are read to confirm they do not
restate the order. `test/prompt-envelope.test.ts` asserts against prompt text, so it is re-run
against the edit rather than assumed unaffected.

### `src/server/db/schema.ts`, `src/server/db/migrations/`
`llm_calls` gains `first_token_ms integer` (nullable: a non-streaming provider has no such
moment, and a zero would claim one). One migration, checked in, applied on startup like every
other. It is a duration, not content, so §3's rule on the audit table holds.

### `src/app/ask/ask-form.tsx`
§10.

### `test/` — `partialJson.test.ts`, `restoreStream.test.ts` (new); `answer.test.ts` extended.

## 12. Tests

- `readPartial`: citations complete / incomplete / absent; answer string with each escape class;
  a half-written `\u` at the buffer end; field order reversed (returns null citations until the
  end); malformed JSON never throws.
- `createRestorer`: a placeholder split across every internal boundary; a `[` that never becomes a
  placeholder; adjacent placeholders; `flush` after an unterminated `[`; text with no placeholders
  passes through unchanged.
- `askQuestionStream`: emits `citations` before any `delta`; emits `not_found` and no delta when
  the stub cites `[99]`; the retry path; `budget_exhausted` from the injected `reserveCall`. The
  existing stub-driven tests reach all of this without a database or a key, as they do today.
- `askQuestion` (the collector) keeps its current tests, unchanged. That they still pass is the
  evidence the restructuring preserved behaviour.

No test loads a model or opens a connection, consistent with gaps 23, 29 and 34.

## 13. What gets measured, on the running stack

Through `openrouter`, the live path this project actually has:

1. **Time to first token vs. today's time to answer**, same question, same corpus. The number the
   slice exists for.
2. **Whether the model honours field order** — how often `citations` completes before the prose
   begins. If it is unreliable, §8 means the feature degrades rather than breaks, and the README
   says so with the rate.
3. **Whether citations-first changes citation quality.** The model now commits to sources before
   composing prose, which is a real risk to the thing this app promises. Measured as the citation
   guard's rejection rate and the cited-source correctness over the seed corpus's questions,
   before and after. **If this degrades, the slice does not land** — latency is not worth
   trading the one functional promise for, and that verdict is written into the README either way.

## 14. New gaps this opens

- The `anthropic` and `gateway` providers do not stream, so a deployment on either gets one big
  delta. Deliberate (§6), and it joins gaps 1 and 2 as something a vendor key would settle.
- Time-to-first-token is measured on one model, one corpus, one day.
- A stream broken mid-prose leaves the user a partial answer. It is marked, not resumable: a
  resume would mean a second charged call for text already paid for.
- `readPartial` re-scans the accumulated buffer on every delta, which is O(n²) over a response.
  Fine for answers of this size, and the honest note is that it is fine *because* of the size.

## 15. Verification

- `npm test`, `npm run typecheck`.
- `docker compose up`, one question, watch prose arrive after the sources appear.
- The `[99]` stub still yields `not_found` with no prose emitted — the guarantee, demonstrated.
- `llm_calls` contains `firstTokenMs` and still contains no content.
- The redaction badge still reports the same counts for the demo question.
- `LLM_PROVIDER=mock` streams with no key set, per §5 of CLAUDE.md.

## 16. Rejected

- **SSE.** GET-shaped, and its reconnect semantics would imply a second charged call.
- **A line-based wire contract** (`CITATIONS: [1,2]` then prose). It removes partial-JSON parsing
  entirely, which is the fiddliest part of this slice — but it abandons the zod-validated JSON
  contract and `structuredOutputs`, leaving two response formats to keep in step for one feature.
- **Streaming provisionally, marked unverified.** Rejected with the user: it gives the full
  latency win but lets a reader read prose that then disappears.
- **A separate streaming orchestrator.** Two copies of the citation guard, which is the one
  duplication this project cannot afford.
