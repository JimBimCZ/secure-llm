import { getLlmProvider } from "@/server/ai";
import { answerStreamWithAudit, answerWithAudit } from "@/server/ai/call";
import type {
  AnswerInput,
  AnswerResult,
  AnswerStreamEvent,
} from "@/server/ai/types";
import { logger } from "@/server/log/logger";
import { getPersonDetector } from "@/server/privacy/detectors";
import { createAnonymizer, type RedactionCounts } from "@/server/privacy/anonymizer";
import { createRestorer } from "@/server/privacy/restoreStream";
import { resolveCitations, type Citation } from "@/server/rag/citations";
import { retrieveChunks, type RetrievedChunk } from "@/server/rag/retrieve";
import {
  recordTokens,
  reserveCall,
  type Reservation,
  type SpendScope,
} from "@/server/spend";

export type { Citation };

export interface Privacy {
  /** The question exactly as it left this process. Contains no personal data. */
  redactedQuestion: string;
  /** How many DISTINCT values were replaced across the question and sources. */
  replaced: RedactionCounts;
}

export type AskResult =
  | {
      status: "answered";
      answer: string;
      citations: Citation[];
      privacy: Privacy;
    }
  /** The honest outcome. `reason` is for the log and the UI's explanation. */
  | { status: "not_found"; reason: "no_relevant_chunks" | "citations_rejected" }
  /**
   * A ceiling had no room for the call. Distinct from `not_found` because
   * nothing was searched and found wanting — the question was never asked.
   * `scope` decides which of the two ceilings the user is told about.
   */
  | {
      status: "budget_exhausted";
      scope: SpendScope;
      retryAfterSeconds: number;
    };

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

/** The text shown for every not_found outcome. One sentence, no hedging. */
export const NOT_FOUND_MESSAGE = "Not found in your knowledge base.";

/**
 * The four things this function reaches outside itself for.
 *
 * Defaulted, so every call site passes a question and nothing else and no
 * wiring exists to get wrong. Named, so a test can drive the orchestration
 * below without a database, an embedder or an API key — including the one
 * branch nothing else can reach. The citation guard's rejection path fires
 * when a model cites a source it was not given, and no provider in this
 * repository does that: the mock cites what it extracted, and asking a real
 * model to misbehave on demand is not a test, it is a hope. A stub that always
 * cites [99] reaches it in one line. The same reason splits spending in two:
 * `reserveCall` lets a test drive the ceiling without a connection, and
 * `recordTokens` lets it assert what a completed call was charged, separately
 * from whether it was allowed to happen at all.
 *
 * A default parameter, not a container. There are four of them.
 */
export interface AskDependencies {
  retrieve: (ownerSub: string, question: string) => Promise<RetrievedChunk[]>;
  /** The audited, timed-out call from ai/call.ts — the one door out. */
  answer: (input: AnswerInput) => Promise<AnswerResult>;
  /**
   * Present when the provider can stream. Absent is not a defect: the
   * orchestrator falls back to `answer` and emits the whole reply as one
   * delta, so there is one code path here regardless.
   */
  answerStream?: (input: AnswerInput) => AsyncIterable<AnswerStreamEvent>;
  /** Reserves one model call against both daily ceilings, atomically. THE
   *  control — the route's pre-check is only an early exit. Injected so the
   *  tests, which may not open a connection, do not reach a database. */
  reserveCall: (ownerSub: string) => Promise<Reservation>;
  /** Adds what a completed call cost. Best-effort; never fails a question. */
  recordTokens: (
    ownerSub: string,
    inputTokens: number,
    outputTokens: number,
  ) => Promise<void>;
}

const LIVE: AskDependencies = {
  retrieve: retrieveChunks,
  answer: (input) => answerWithAudit(getLlmProvider(), input),
  answerStream: (input) => answerStreamWithAudit(getLlmProvider(), input),
  reserveCall,
  recordTokens,
};

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
  // Usage first, unlike a real streaming provider, because for a completed
  // call it is already final — and because the guard below abandons the stream
  // the moment it rejects a citation set. A cost that arrived after that point
  // would never be recorded, and a rejected call is charged exactly like an
  // accepted one.
  yield {
    type: "usage",
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  };
  yield { type: "citations", citations: result.citations };
  yield { type: "delta", text: result.answer };
}

/**
 * Question in, cited answer out — or nothing.
 *
 * The promise in CLAUDE.md §6 is that an answer without a source is not
 * shipped, so this function is written so that "answered" is the narrow path
 * and refusal is the default. Every early return below is a refusal.
 *
 * A citation is a 1-based position in the chunk list we sent, not an id. The
 * model is never shown a chunk id, so it cannot produce one that happens to be
 * real: a citation either indexes the set we retrieved or it does not, and
 * there is no third case to reason about.
 *
 * One retry is allowed, with a stricter prompt, and then we stop. A model that
 * cites badly twice is not going to be argued into citing well, and each retry
 * is another call the user waits for and pays for.
 *
 * ANONYMIZATION (§7) wraps the model call on both sides. One anonymizer is
 * created here, per request, and dies with it — it holds the only mapping that
 * can turn a placeholder back into a person, so it is never stored and never
 * logged. Because the same instance redacts the question AND the chunks, a
 * value gets the same placeholder everywhere: a question about "Marek Dvořák"
 * still matches a chunk about him, since both now say `[PERSON_1]`.
 *
 * This is the ONLY implementation of the guard. `askQuestion` below collects
 * what this yields; it does not decide anything.
 */
export async function* askQuestionStream(
  ownerSub: string,
  question: string,
  deps: AskDependencies = LIVE,
): AsyncGenerator<AskEvent> {
  // Retrieval runs on the ORIGINAL text: embeddings are computed in-process
  // (nothing leaves), and searching redacted text would mean searching for
  // placeholders instead of for what the user actually asked about.
  const retrieved = await deps.retrieve(ownerSub, question);

  // Nothing cleared the similarity floor. The corpus does not cover this, and
  // no model call is made — asking anyway would invite an ungrounded answer.
  if (retrieved.length === 0) {
    logger.info({ sub: ownerSub, outcome: "no_relevant_chunks" }, "ask");
    yield { type: "not_found", reason: "no_relevant_chunks" };
    return;
  }

  const anonymizer = createAnonymizer(getPersonDetector());
  const redactedQuestion = await anonymizer.redact(question);
  // Sequential, and measured: batching the chunks into one model call was
  // slower than this, because the pipeline pads every input to the longest.
  const chunks: AnswerInput["chunks"] = [];
  for (const chunk of retrieved) {
    chunks.push({
      id: chunk.id,
      documentId: chunk.documentId,
      content: await anonymizer.redact(chunk.content),
    });
  }
  const input = { question: redactedQuestion, chunks };

  const privacy: Privacy = {
    redactedQuestion,
    replaced: anonymizer.counts(),
  };

  // Emitted before the first model call, so the UI can show what left the
  // process at the same moment it starts waiting for an answer about it.
  yield { type: "privacy", privacy };

  for (const retry of [false, true]) {
    // Reserved BEFORE the call, not counted after it: the reservation IS the
    // check, so nothing can slip between reading a count and writing it. The
    // retry below is a second real call, so it reserves again.
    const reservation = await deps.reserveCall(ownerSub);

    if (!reservation.allowed) {
      if (retry) {
        // The first attempt was rejected by the citation guard and there is no
        // budget for a second. Fall through to the refusal that attempt had
        // already earned — but say so first, because an unfunded retry that
        // vanished from the log is the one budget event nobody could see.
        logger.warn(
          { sub: ownerSub, scope: reservation.scope, outcome: "retry_unfunded" },
          "ask",
        );
        break;
      }

      logger.warn(
        {
          sub: ownerSub,
          scope: reservation.scope,
          outcome: "budget_exhausted",
        },
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
    let sawCitations = false;
    // Text released by the restorer but not yet shown, because nothing
    // visible has arrived yet. Kept rather than dropped so the streamed text
    // is byte-identical to what the non-streaming path returned: a model that
    // opens with whitespace still gets that whitespace shown.
    let pending = "";
    // Back to plain text on the way out, a piece at a time. The citations keep
    // the original chunk content, which the user owns and is entitled to read.
    const restorer = createRestorer((text) => anonymizer.restore(text));

    /**
     * The ONE gate every piece of prose passes through, whether it came from
     * `push()` during the stream or from `flush()` at the end.
     *
     * Having two gates is how the first version refused a valid answer: an
     * answer held back in its entirety by the restorer (one starting `[` with
     * no `]` within the placeholder window) produced nothing from `push()`, so
     * the citations event never opened, and `flush()`'s tail was then dropped
     * for want of it.
     *
     * It also holds the guard's second half: citations resolve, AND the answer
     * has visible content. Until something non-blank arrives, nothing is shown
     * and nothing is committed to.
     */
    const release = function* (text: string): Generator<AskEvent> {
      if (text.length === 0 || citations.length === 0) return;

      if (emittedCitations) {
        yield { type: "delta", text };
        return;
      }

      pending += text;
      if (pending.trim().length === 0) return;

      emittedCitations = true;
      yield { type: "citations", citations };
      yield { type: "delta", text: pending };
      pending = "";
    };

    try {
      for await (const event of stream) {
        if (event.type === "usage") {
          usage = {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
          };
          continue;
        }

        if (event.type === "citations") {
          // The first set is the one the guard rules on. A second set cannot
          // retroactively justify prose already shown, and must not be able to
          // slip past a gate the first set already opened.
          if (sawCitations) continue;
          sawCitations = true;
          returnedCitations = event.citations.length;
          citations = resolveCitations(event.citations, retrieved);
          // Nothing is emitted here. An invalid set means this attempt is over,
          // and the user has been shown nothing to take back.
          if (citations.length === 0) break;
          continue;
        }

        // A delta before any citations event, or after a rejected one, is prose
        // with nothing to justify it. `release` drops it rather than show it.
        yield* release(restorer.push(event.text));
      }

      yield* release(restorer.flush());
    } finally {
      // The call was charged above, before it was made. Only its cost is known
      // now, and only now can it be recorded.
      //
      // In a `finally`, so it runs even when the consumer stops iterating — a
      // client disconnect must not turn a call we already reserved into one we
      // never charged.
      await deps.recordTokens(ownerSub, usage.inputTokens, usage.outputTokens);
    }

    // Both halves of the guard are already spent by the time we get here:
    // citations resolved at the `resolveCitations` call above, and visible
    // content at the `pending.trim()` check inside `release`. This flag is set
    // only when both passed, so there is one condition to test, not two.
    if (emittedCitations) {
      logger.info(
        {
          sub: ownerSub,
          outcome: "answered",
          retried: retry,
          chunksRetrieved: retrieved.length,
          // How many chunks the lexical arms contributed. Worth a number in the
          // log: it is the only way to see hybrid retrieval doing anything.
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

    // Worth a warning: a model citing outside the set it was given is the
    // failure this whole guard exists for, and it should be visible in the
    // logs rather than silently absorbed by the retry.
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
