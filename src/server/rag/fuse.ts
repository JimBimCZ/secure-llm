/**
 * Combining the retrieval arms into one ranked list.
 *
 * The three arms score in units that cannot be compared. The vector arm orders
 * by cosine similarity, which lies in [-1, 1] and is only bounded below by
 * RAG_MIN_SCORE for the rows that arm itself admitted; the identifier arm
 * orders by a text rank that is unbounded and depends on how common the words
 * are in this particular corpus; the prose arm orders by BM25, which is
 * unbounded again and on a different scale from either. Normalising them onto
 * one another would mean inventing two conversions and then defending numbers
 * nobody can derive. Their RANKS, though, are directly comparable — "this
 * arm's best hit" means the same thing in all three.
 *
 * Hence reciprocal rank fusion: each arm contributes 1/(K + rank) to a chunk's
 * score, and a chunk found by more than one arm collects a contribution from
 * each. It is the standard method for exactly this problem, it has one
 * constant, and it needs no tuning against this corpus.
 *
 * What this function must NOT do is decide relevance. Every list arrives
 * already filtered in SQL — by owner, by embedding model, and each by its own
 * admission rule — so every row here has earned its place. Fusion only orders,
 * and an empty result stays empty, because retrieval returning nothing is what
 * produces "Not found in your knowledge base." without a model call.
 */

/**
 * The conventional constant from the original RRF paper. It damps the
 * difference between the top ranks, so a chunk found by two arms outranks one
 * found first by a single arm — which is the behaviour we want, and the reason
 * a hybrid list beats any one arm alone.
 */
const K = 60;

/** Which arm found a chunk. Recorded, not acted on. */
export type Arm = "vector" | "lexical" | "prose";

/** One arm's ranked output, best first. */
export interface ArmResult<T> {
  arm: Arm;
  rows: T[];
}

/**
 * Merge ranked lists into one, best first.
 *
 * Arms are independent: each arrives already filtered in SQL by its own
 * admission rule, so there is no relevance decision left to take here. With one
 * non-empty arm this returns that arm's list unchanged, because a single arm's
 * contribution 1/(K + rank) falls monotonically with rank.
 *
 * Ties break towards the arm given first — `Map` preserves insertion order and
 * `Array.prototype.sort` is stable — so callers pass the vector arm first and
 * semantic similarity stays the default.
 */
export function fuseByRank<T extends { id: string }>(
  arms: Array<ArmResult<T>>,
  limit: number,
): Array<T & { matchedBy: Arm[] }> {
  const fused = new Map<string, { row: T; score: number; matchedBy: Arm[] }>();

  for (const { arm, rows } of arms) {
    rows.forEach((row, index) => {
      const contribution = 1 / (K + index + 1);
      const seen = fused.get(row.id);

      if (seen) {
        seen.score += contribution;
        seen.matchedBy.push(arm);
        return;
      }

      fused.set(row.id, { row, score: contribution, matchedBy: [arm] });
    });
  }

  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ row, matchedBy }) => ({ ...row, matchedBy }));
}
