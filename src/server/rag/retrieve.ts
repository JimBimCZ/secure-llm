import { and, cosineDistance, desc, eq, gt, sql } from "drizzle-orm";

import { getEmbedder } from "@/server/ai";
import { db } from "@/server/db";
import { chunks, documents } from "@/server/db/schema";
import { env } from "@/server/env";

export interface RetrievedChunk {
  id: string;
  documentId: string;
  filename: string;
  chunkIndex: number;
  content: string;
  /** Cosine similarity in [0, 1]. Both embedders return unit vectors. */
  score: number;
}

/**
 * Vector search over the signed-in user's own chunks.
 *
 * Three things are true of the WHERE clause below, and all three are load-
 * bearing (CLAUDE.md §6):
 *
 * - Ownership is filtered IN SQL, in the same predicate as the search, never in
 *   application code after the fetch. There is no code path that can hold
 *   another user's chunk in memory and forget to drop it.
 * - The active embedding model is filtered too. Vectors from two models are not
 *   comparable, so a switched embedder must return NOTHING rather than a
 *   confidently-ranked list of nonsense. "No results" is a visible failure;
 *   wrong rankings are not.
 * - The similarity floor is applied here rather than after ranking, so a query
 *   the corpus cannot answer comes back empty instead of coming back with its
 *   six least-bad chunks.
 */
export async function retrieveChunks(
  ownerSub: string,
  question: string,
): Promise<RetrievedChunk[]> {
  const embedder = getEmbedder();
  const [vector] = await embedder.embed([question]);
  if (!vector) return [];

  const similarity = sql<number>`1 - (${cosineDistance(chunks.embedding, vector)})`;

  return db
    .select({
      id: chunks.id,
      documentId: chunks.documentId,
      filename: documents.filename,
      chunkIndex: chunks.chunkIndex,
      content: chunks.content,
      score: similarity,
    })
    .from(chunks)
    .innerJoin(documents, eq(documents.id, chunks.documentId))
    .where(
      and(
        eq(chunks.ownerSub, ownerSub),
        eq(chunks.embeddingModel, embedder.model),
        gt(similarity, env.RAG_MIN_SCORE),
      ),
    )
    .orderBy(desc(similarity))
    .limit(env.RAG_TOP_K);
}
