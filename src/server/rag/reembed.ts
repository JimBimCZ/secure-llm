import { and, eq } from "drizzle-orm";

import { getEmbedder } from "@/server/ai";
import { db } from "@/server/db";
import { chunks, documents } from "@/server/db/schema";
import { logger } from "@/server/log/logger";
import { chunkText } from "@/server/rag/chunk";
import { staleDocumentIds } from "@/server/rag/embeddingStatus";

export interface ReembedResult {
  /** Documents rebuilt against the active model. */
  documents: number;
  /** Chunks written. Not necessarily the number that were replaced. */
  chunks: number;
  /** Documents left exactly as they were, because rebuilding them failed. */
  failed: number;
}

/**
 * Rebuild the caller's stale documents against the embedder now in force.
 *
 * WHY IT RE-CHUNKS instead of re-embedding the stored chunk text. Chunk size is
 * dictated by the embedding model's input window, not chosen freely (§6): the
 * current 1500 characters is what fits all-MiniLM-L6-v2's 512 tokens with a
 * pessimistic character-per-token budget. A different model can mean different
 * boundaries, so replaying the old ones would carry the old model's constraint
 * into the new model's index. The stored document text is the input, exactly as
 * at ingest.
 *
 * WHAT IT DOES NOT DO is re-extract. `documents.content` is the text as it was
 * read at upload, so a document ingested before a change to the extractor keeps
 * whatever that extractor produced — notably the PDF line-break repair, which
 * only reaches documents uploaded after it. "Re-embed" sounds like it would fix
 * that, and it does not; the README says so.
 *
 * ONE TRANSACTION PER DOCUMENT, and a failure inside one is caught and counted
 * rather than thrown. A document either has its old chunks or its new ones,
 * never a mixture, and one unreadable document does not abandon the other nine
 * — which matters because the alternative is a user who cannot get past it.
 * Re-running is safe: a document rebuilt on the last attempt is no longer
 * stale, so it is no longer selected.
 *
 * It runs inside the request. The corpus is one user's own and personal-scale
 * (README gap 6), and a job queue for an operation taken by hand, once, after
 * changing an environment variable would be more machinery than the work.
 */
export async function reembedStaleDocuments(
  ownerSub: string,
): Promise<ReembedResult> {
  const embedder = getEmbedder();
  const ids = await staleDocumentIds(ownerSub);
  const startedAt = Date.now();

  const result: ReembedResult = { documents: 0, chunks: 0, failed: 0 };

  for (const documentId of ids) {
    try {
      // Ownership again, in SQL, on the read that decides what gets rewritten.
      // `staleDocumentIds` already filtered by owner; this is the predicate
      // that would have to be forgotten twice for a document to be touched by
      // someone who does not own it.
      const [document] = await db
        .select({ content: documents.content })
        .from(documents)
        .where(and(eq(documents.id, documentId), eq(documents.ownerSub, ownerSub)));

      if (!document) {
        result.failed += 1;
        continue;
      }

      const pieces = chunkText(document.content);

      // Nothing to index. Deleting the old chunks and inserting none would
      // trade a stale document for an invisible one, so it is left alone and
      // reported as a failure — which is what it is.
      if (pieces.length === 0) {
        result.failed += 1;
        continue;
      }

      const vectors = await embedder.embed(pieces.map((piece) => piece.content));

      await db.transaction(async (tx) => {
        await tx.delete(chunks).where(eq(chunks.documentId, documentId));
        await tx.insert(chunks).values(
          pieces.map((piece, i) => ({
            documentId,
            ownerSub,
            chunkIndex: piece.index,
            content: piece.content,
            startOffset: piece.startOffset,
            endOffset: piece.endOffset,
            embedding: vectors[i]!,
            embeddingModel: embedder.model,
          })),
        );
      });

      result.documents += 1;
      result.chunks += pieces.length;
    } catch (error) {
      // Never fatal for the rest. Nothing here logs document text (§3).
      logger.error({ err: error, sub: ownerSub, documentId }, "re-embedding failed");
      result.failed += 1;
    }
  }

  logger.info(
    {
      sub: ownerSub,
      embedder: embedder.name,
      model: embedder.model,
      documents: result.documents,
      chunks: result.chunks,
      failed: result.failed,
      durationMs: Date.now() - startedAt,
    },
    "re-embedded stale documents",
  );

  return result;
}
