import { getLlmProvider } from "@/server/ai";
import { answerWithAudit } from "@/server/ai/call";
import type { AnswerInput, AnswerResult } from "@/server/ai/types";
import { logger } from "@/server/log/logger";
import { getPersonDetector } from "@/server/privacy/detectors";
import { createAnonymizer, type RedactionCounts } from "@/server/privacy/anonymizer";
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
  reserveCall,
  recordTokens,
};

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
 */
export async function askQuestion(
  ownerSub: string,
  question: string,
  deps: AskDependencies = LIVE,
): Promise<AskResult> {
  // Retrieval runs on the ORIGINAL text: embeddings are computed in-process
  // (nothing leaves), and searching redacted text would mean searching for
  // placeholders instead of for what the user actually asked about.
  const retrieved = await deps.retrieve(ownerSub, question);

  // Nothing cleared the similarity floor. The corpus does not cover this, and
  // no model call is made — asking anyway would invite an ungrounded answer.
  if (retrieved.length === 0) {
    logger.info({ sub: ownerSub, outcome: "no_relevant_chunks" }, "ask");
    return { status: "not_found", reason: "no_relevant_chunks" };
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

      return {
        status: "budget_exhausted",
        scope: reservation.scope,
        retryAfterSeconds: reservation.retryAfterSeconds,
      };
    }

    const result = await deps.answer({ ...input, retry });

    // The call was charged above, before it was made. Only its cost is known
    // now, and only now can it be recorded.
    await deps.recordTokens(
      ownerSub,
      result.usage.inputTokens,
      result.usage.outputTokens,
    );

    const citations = resolveCitations(result.citations, retrieved);

    if (citations.length > 0 && result.answer.trim().length > 0) {
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

      return {
        status: "answered",
        // Back to plain text on the way out. The citations keep the original
        // chunk content, which the user owns and is entitled to read.
        answer: anonymizer.restore(result.answer),
        citations,
        privacy,
      };
    }

    // Worth a warning: a model citing outside the set it was given is the
    // failure this whole guard exists for, and it should be visible in the
    // logs rather than silently absorbed by the retry.
    logger.warn(
      {
        sub: ownerSub,
        retried: retry,
        returnedCitations: result.citations.length,
        validCitations: citations.length,
      },
      "answer rejected by citation guard",
    );
  }

  logger.info({ sub: ownerSub, outcome: "citations_rejected" }, "ask");
  return { status: "not_found", reason: "citations_rejected" };
}
