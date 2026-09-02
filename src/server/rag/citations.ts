/**
 * Turning what the model claimed into what it is allowed to claim.
 *
 * This is the enforcing half of the promise in CLAUDE.md §6, and it lives in
 * its own file with no imports for two reasons: it is the piece most worth
 * testing, and a unit test of it should not need a database, an embedder or an
 * environment. Everything it needs arrives as arguments.
 */

/** The shape a citation is resolved against. `RetrievedChunk` satisfies it. */
export interface CitableChunk {
  id: string;
  documentId: string;
  filename: string;
  chunkIndex: number;
  content: string;
}

export interface Citation {
  chunkId: string;
  documentId: string;
  filename: string;
  chunkIndex: number;
  /** The passage the answer was drawn from, so the UI can show it in place. */
  content: string;
}

/**
 * Positions to real chunks, dropping anything out of range or repeated.
 *
 * Dropping rather than repairing is the point. If the model cited [9] out of
 * six sources, that citation supports nothing, and an answer left with no
 * surviving citations is rejected by the caller — a fabricated citation must
 * cost the answer, not be quietly rounded down to the nearest real source.
 *
 * Order follows the model's, so the UI lists sources in the order the answer
 * used them.
 */
export function resolveCitations(
  positions: number[],
  retrieved: CitableChunk[],
): Citation[] {
  const seen = new Set<number>();
  const citations: Citation[] = [];

  for (const position of positions) {
    if (
      !Number.isInteger(position) ||
      position < 1 ||
      position > retrieved.length ||
      seen.has(position)
    ) {
      continue;
    }
    seen.add(position);

    const chunk = retrieved[position - 1]!;
    citations.push({
      chunkId: chunk.id,
      documentId: chunk.documentId,
      filename: chunk.filename,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
    });
  }

  return citations;
}
