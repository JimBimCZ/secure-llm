import { and, eq, ne, sql } from "drizzle-orm";

import { getEmbedder } from "@/server/ai";
import { db } from "@/server/db";
import { chunks } from "@/server/db/schema";

/** How many chunks, in how many documents, one embedding model produced. */
export interface ModelChunkCount {
  model: string;
  chunks: number;
  documents: number;
}

export interface EmbeddingStatus {
  /** What retrieval is filtering on right now. */
  activeModel: string;
  /** Chunks that model produced — the only ones a question can currently find. */
  currentChunks: number;
  /** Everything else, largest first. Empty when nothing is stale. */
  stale: ModelChunkCount[];
  /** Exact: a chunk carries exactly one model, so these sum without overlap. */
  staleChunks: number;
}

/**
 * Which of a user's chunks the active embedder can still see.
 *
 * Retrieval filters `embedding_model` in the same predicate as ownership,
 * because vectors from two models are not comparable and a switched embedder
 * must return NOTHING rather than a confidently-ranked list of nonsense
 * (see rag/retrieve.ts). The failure that leaves is silent: every question
 * refuses, and the documents page goes on reporting chunks that no query can
 * reach. This is what makes it sayable.
 *
 * Document counts are per model rather than totalled. A chunk has one model so
 * chunk counts add up exactly, but a document could in principle hold chunks
 * from two of them, and a total that quietly counted it twice would be the
 * wrong kind of number to put in a warning about wrong numbers.
 */
export function describeStaleness(
  rows: ModelChunkCount[],
  activeModel: string,
): EmbeddingStatus {
  const stale = rows
    .filter((row) => row.model !== activeModel)
    .sort((a, b) => b.chunks - a.chunks);

  return {
    activeModel,
    currentChunks: rows
      .filter((row) => row.model === activeModel)
      .reduce((sum, row) => sum + row.chunks, 0),
    stale,
    staleChunks: stale.reduce((sum, row) => sum + row.chunks, 0),
  };
}

/**
 * The caller's own chunks, grouped by the model that embedded them.
 *
 * Ownership is a WHERE clause, as everywhere else that touches chunks. One
 * grouped count over an index the retrieval path already needs; it runs on
 * every page render, so it stays a single aggregate and nothing more.
 */
export async function getEmbeddingStatus(
  ownerSub: string,
): Promise<EmbeddingStatus> {
  const embedder = getEmbedder();

  const rows = await db
    .select({
      model: chunks.embeddingModel,
      chunks: sql<number>`count(*)::int`,
      documents: sql<number>`count(distinct ${chunks.documentId})::int`,
    })
    .from(chunks)
    .where(eq(chunks.ownerSub, ownerSub))
    .groupBy(chunks.embeddingModel);

  return describeStaleness(rows, embedder.model);
}

/** The documents holding at least one chunk the active embedder cannot see. */
export async function staleDocumentIds(ownerSub: string): Promise<string[]> {
  const embedder = getEmbedder();

  const rows = await db
    .selectDistinct({ documentId: chunks.documentId })
    .from(chunks)
    .where(
      and(
        eq(chunks.ownerSub, ownerSub),
        ne(chunks.embeddingModel, embedder.model),
      ),
    );

  return rows.map((row) => row.documentId);
}
