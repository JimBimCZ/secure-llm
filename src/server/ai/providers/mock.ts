import { significantTerms } from "@/server/ai/lexical";
import type { AnswerInput, AnswerResult, LlmProvider } from "@/server/ai/types";

/**
 * Answers with no network, no key and no model — the default, and therefore the
 * path you get on `docker compose up` before setting anything.
 *
 * It does not generate. It EXTRACTS: it scores every sentence in the retrieved
 * chunks by how much vocabulary it shares with the question, and returns the
 * best few verbatim, citing the chunks they came from. So the answer is
 * genuinely grounded in the user's documents, the citations are genuinely the
 * sources used, and the whole pipeline — retrieval, the citation guard, the
 * source links in the UI — is exercised end to end.
 *
 * What it cannot do, and the README says so plainly: it cannot synthesise
 * across two documents, resolve a pronoun, or rephrase. Ask it something whose
 * answer is spread over three notes and you get the single closest sentence,
 * not a summary. That is the honest cost of a demo that needs no API key.
 */

/** Beyond this the "answer" stops reading like one and starts being a dump. */
const MAX_SENTENCES = 3;
/** A sentence sharing fewer terms than this with the question is noise. */
const MIN_SHARED_TERMS = 1;

interface Candidate {
  sentence: string;
  /** 1-based position in AnswerInput.chunks — what the guard checks. */
  citation: number;
  score: number;
}

/**
 * Prose sentences only.
 *
 * Three things had to be handled, all found by reading what the first version
 * actually produced against the seed corpus rather than by imagining it:
 *
 * - Markdown tables and headings are dropped. A table row shares plenty of
 *   vocabulary with the question and scores well, but "| GPU | Rated total
 *   board power | 320 W |" is not an answer, and the first version led with it.
 * - Whitespace inside a paragraph is collapsed BEFORE splitting. Splitting on
 *   newlines cut hard-wrapped prose mid-sentence and returned "As recorded in
 *   my GPU" as if it were a complete thought.
 * - Blocks are separated on blank lines, so a sentence never spans a paragraph.
 */
function sentences(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .filter((block) => {
      const trimmed = block.trim();
      // Markdown table rows and headings: structure, not prose.
      return !trimmed.startsWith("|") && !trimmed.startsWith("#");
    })
    .flatMap((block) =>
      block
        .replace(/\s+/g, " ")
        .split(/(?<=[.!?])\s+/),
    )
    .map((s) => s.trim())
    .filter((s) => s.length > 30);
}

export function createMockLlmProvider(): LlmProvider {
  return {
    name: "mock",
    model: "mock-extractive-v1",

    async answer(input: AnswerInput): Promise<AnswerResult> {
      const asked = new Set(significantTerms(input.question).keys());

      const candidates: Candidate[] = [];
      // Chunks overlap by ~100 tokens by design, so the same sentence reaches
      // us more than once. Keeping the first occurrence keeps the citation
      // pointing at the higher-ranked chunk.
      const seenSentences = new Set<string>();

      input.chunks.forEach((chunk, i) => {
        for (const sentence of sentences(chunk.content)) {
          if (seenSentences.has(sentence)) continue;
          seenSentences.add(sentence);

          const terms = significantTerms(sentence);
          let shared = 0;
          for (const term of terms.keys()) if (asked.has(term)) shared += 1;

          // Divide by length so a long paragraph does not win on volume alone.
          if (shared >= MIN_SHARED_TERMS) {
            candidates.push({
              sentence,
              citation: i + 1,
              score: shared / Math.sqrt(terms.size || 1),
            });
          }
        }
      });

      // Retrieval already ranked the chunks, so falling back to the opening of
      // the best one is better than returning nothing when no sentence shares
      // vocabulary with the question.
      if (candidates.length === 0) {
        const best = input.chunks[0];
        if (!best) return { answer: "", citations: [], usage: usageOf("") };

        const opening = sentences(best.content).slice(0, MAX_SENTENCES).join(" ");
        return {
          answer: opening,
          citations: [1],
          usage: usageOf(input.question + opening),
        };
      }

      const chosen = candidates
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_SENTENCES);

      const answer = chosen.map((c) => c.sentence).join(" ");
      // Cite each source once, in the order the sentences appear in the answer.
      const citations = [...new Set(chosen.map((c) => c.citation))];

      return { answer, citations, usage: usageOf(input.question + answer) };
    },
  };
}

/**
 * The mock has no tokenizer, so these are ESTIMATES at the usual ~4 characters
 * per token — recorded so the audit trail in §3 has real-shaped numbers to
 * show, and named as estimates so nobody mistakes them for metering.
 */
function usageOf(text: string): AnswerResult["usage"] {
  const estimate = Math.ceil(text.length / 4);
  return { inputTokens: estimate, outputTokens: estimate };
}
