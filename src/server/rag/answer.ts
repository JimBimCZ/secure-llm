import { getLlmProvider } from "@/server/ai";
import { answerWithAudit } from "@/server/ai/call";
import { logger } from "@/server/log/logger";
import { createAnonymizer, type RedactionCounts } from "@/server/privacy/anonymizer";
import { resolveCitations, type Citation } from "@/server/rag/citations";
import { retrieveChunks } from "@/server/rag/retrieve";

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
  | { status: "not_found"; reason: "no_relevant_chunks" | "citations_rejected" };

/** The text shown for every not_found outcome. One sentence, no hedging. */
export const NOT_FOUND_MESSAGE = "Not found in your knowledge base.";

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
): Promise<AskResult> {
  // Retrieval runs on the ORIGINAL text: embeddings are computed in-process
  // (nothing leaves), and searching redacted text would mean searching for
  // placeholders instead of for what the user actually asked about.
  const retrieved = await retrieveChunks(ownerSub, question);

  // Nothing cleared the similarity floor. The corpus does not cover this, and
  // no model call is made — asking anyway would invite an ungrounded answer.
  if (retrieved.length === 0) {
    logger.info({ sub: ownerSub, outcome: "no_relevant_chunks" }, "ask");
    return { status: "not_found", reason: "no_relevant_chunks" };
  }

  const anonymizer = createAnonymizer();
  const redactedQuestion = anonymizer.redact(question);
  const input = {
    question: redactedQuestion,
    chunks: retrieved.map((c) => ({
      id: c.id,
      documentId: c.documentId,
      content: anonymizer.redact(c.content),
    })),
  };

  const privacy: Privacy = {
    redactedQuestion,
    replaced: anonymizer.counts(),
  };

  for (const retry of [false, true]) {
    const result = await answerWithAudit(getLlmProvider(), { ...input, retry });
    const citations = resolveCitations(result.citations, retrieved);

    if (citations.length > 0 && result.answer.trim().length > 0) {
      logger.info(
        {
          sub: ownerSub,
          outcome: "answered",
          retried: retry,
          chunksRetrieved: retrieved.length,
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
