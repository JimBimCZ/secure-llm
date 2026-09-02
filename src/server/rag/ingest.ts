import { getEmbedder } from "@/server/ai";
import { db } from "@/server/db";
import { chunks, documents } from "@/server/db/schema";
import { logger } from "@/server/log/logger";
import { chunkText } from "@/server/rag/chunk";
import { extractDocumentText } from "@/server/rag/extract";

export interface IngestResult {
  documentId: string;
  chunkCount: number;
}

/**
 * extract → chunk → embed → store, in one transaction.
 *
 * A document is only visible once all of its chunks are embedded and written,
 * so a failure part-way through leaves nothing half-indexed for retrieval to
 * find. Nothing here logs document text (CLAUDE.md §3).
 */
export async function ingestDocument(params: {
  ownerSub: string;
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
}): Promise<IngestResult> {
  const { ownerSub, filename, mediaType, bytes } = params;
  const startedAt = Date.now();

  // Read the size first: pdf.js takes ownership of the typed array it is given
  // and detaches the underlying buffer, after which byteLength reads as 0.
  const byteSize = bytes.byteLength;

  const text = await extractDocumentText(filename, bytes);
  const pieces = chunkText(text);

  if (pieces.length === 0) {
    throw new Error("Document contains no extractable text");
  }

  const embedder = getEmbedder();
  const vectors = await embedder.embed(pieces.map((p) => p.content));

  const documentId = await db.transaction(async (tx) => {
    const [document] = await tx
      .insert(documents)
      .values({
        ownerSub,
        filename,
        mediaType,
        content: text,
        byteSize,
      })
      .returning({ id: documents.id });

    const id = document!.id;

    await tx.insert(chunks).values(
      pieces.map((piece, i) => ({
        documentId: id,
        ownerSub,
        chunkIndex: piece.index,
        content: piece.content,
        startOffset: piece.startOffset,
        endOffset: piece.endOffset,
        embedding: vectors[i]!,
        embeddingModel: embedder.model,
      })),
    );

    return id;
  });

  logger.info(
    {
      sub: ownerSub,
      documentId,
      chunkCount: pieces.length,
      bytes: byteSize,
      embedder: embedder.name,
      durationMs: Date.now() - startedAt,
    },
    "document ingested",
  );

  return { documentId, chunkCount: pieces.length };
}
