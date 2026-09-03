import { and, cosineDistance, desc, eq, gt, sql } from "drizzle-orm";

import { getEmbedder } from "@/server/ai";
import { db } from "@/server/db";
import { chunks, documents } from "@/server/db/schema";
import { env } from "@/server/env";
import { fuseByRank, type MatchedBy } from "@/server/rag/fuse";
import { distinctiveTerms } from "@/server/rag/tokens";

export interface RetrievedChunk {
  id: string;
  documentId: string;
  filename: string;
  chunkIndex: number;
  content: string;
  /** Cosine similarity in [0, 1]. Both embedders return unit vectors. */
  score: number;
  /** Which arm found it. Recorded for the log; nothing branches on it. */
  matchedBy: MatchedBy;
}

/** A row as it comes back from either arm, before fusion labels it. */
type ScoredChunk = Omit<RetrievedChunk, "matchedBy">;

/**
 * Retrieval over the signed-in user's own chunks — two arms, one ranked list.
 *
 * THE VECTOR ARM is the primary one and is unchanged from when it was the only
 * one. Three things are true of its WHERE clause, and all three are
 * load-bearing (CLAUDE.md §6):
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
 *
 * THE LEXICAL ARM exists because embeddings are good at meaning and bad at
 * identifiers: a sentence model puts "ddr5-6000" and "ddr5-5600" in nearly the
 * same place, which is precisely wrong when the question is which of the two to
 * buy. It runs ONLY when the question contains something that looks like a part
 * number, and it demands that every one of those tokens is present. When the
 * question has none — the overwhelmingly common case — the arm does not run at
 * all and retrieval is byte-identical to what it was before.
 *
 * That narrowness is what keeps the citation guarantee intact. "Not found in
 * your knowledge base." is reached by retrieval returning nothing, before any
 * model call; a broad keyword arm would answer almost every question with
 * something, and the refusal would come to depend on a similarity threshold
 * invented for text ranks. There is no such threshold here, and no new
 * environment variable: a chunk either contains the identifier or it does not.
 *
 * The lexical arm repeats the ownership and embedding-model predicates rather
 * than trusting the vector arm to have applied them. It also means an embedder
 * swap still degrades to nothing at all, instead of to a half-working app
 * answering only the questions that happen to mention a part number.
 */
export async function retrieveChunks(
  ownerSub: string,
  question: string,
): Promise<RetrievedChunk[]> {
  const embedder = getEmbedder();
  const [vector] = await embedder.embed([question]);
  if (!vector) return [];

  const similarity = sql<number>`1 - (${cosineDistance(chunks.embedding, vector)})`;

  const columns = {
    id: chunks.id,
    documentId: chunks.documentId,
    filename: documents.filename,
    chunkIndex: chunks.chunkIndex,
    content: chunks.content,
    // Selected by BOTH arms, and gated by neither on the lexical side. A chunk
    // the embedder scored poorly still gets its true similarity reported, so
    // `score` means the same thing on every row that leaves this function.
    score: similarity,
  };

  const owned = and(
    eq(chunks.ownerSub, ownerSub),
    eq(chunks.embeddingModel, embedder.model),
  );

  const byVector: Promise<ScoredChunk[]> = db
    .select(columns)
    .from(chunks)
    .innerJoin(documents, eq(documents.id, chunks.documentId))
    .where(and(owned, gt(similarity, env.RAG_MIN_SCORE)))
    .orderBy(desc(similarity))
    .limit(env.RAG_TOP_K);

  // One `phraseto_tsquery` per term, ANDed together. Two properties, both
  // wanted: asking about "ddr5-6000 CL30" reaches the chunk discussing BOTH
  // rather than every chunk mentioning either, and a term that is two words
  // ("lga 1718") demands they sit ADJACENT in the chunk. The second is what
  // makes the bare number in such a pair safe to search for at all — it is
  // never looked for on its own. For a one-word term this is exactly what
  // `plainto_tsquery` did before, so nothing about the existing behaviour
  // moves. Every term is bound as a parameter, so a question can never write
  // the query it is searched with.
  const terms = distinctiveTerms(question);
  // Parenthesised, because `@@` binds tighter than `&&`: without the brackets
  // `tsv @@ a && b` parses as `(tsv @@ a) && b` and Postgres rejects it.
  const tsquery = sql`(${sql.join(
    terms.map((term) => sql`phraseto_tsquery('simple', ${term})`),
    sql` && `,
  )})`;

  const byTokens: Promise<ScoredChunk[]> =
    terms.length === 0
      ? Promise.resolve([])
      : db
          .select(columns)
          .from(chunks)
          .innerJoin(documents, eq(documents.id, chunks.documentId))
          .where(and(owned, sql`${chunks.contentTsv} @@ ${tsquery}`))
          .orderBy(desc(sql`ts_rank_cd(${chunks.contentTsv}, ${tsquery})`))
          .limit(env.RAG_TOP_K);

  const [vectorHits, lexicalHits] = await Promise.all([byVector, byTokens]);

  return fuseByRank(vectorHits, lexicalHits, env.RAG_TOP_K);
}
