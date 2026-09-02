import { count, desc, eq, sql } from "drizzle-orm";

import { authErrorResponse, requireUser } from "@/server/auth/guard";
import { db } from "@/server/db";
import { chunks, documents } from "@/server/db/schema";
import { UnsupportedFormatError } from "@/server/rag/extract";
import { ingestDocument } from "@/server/rag/ingest";

export const dynamic = "force-dynamic";

/** 10 MB. Large enough for the accepted formats, small enough to bound memory. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** The caller's own documents. Ownership is a WHERE clause, never a filter in JS. */
export async function GET() {
  try {
    const { sub } = await requireUser();

    const rows = await db
      .select({
        id: documents.id,
        filename: documents.filename,
        mediaType: documents.mediaType,
        byteSize: documents.byteSize,
        createdAt: documents.createdAt,
        chunkCount: sql<number>`count(${chunks.id})::int`,
      })
      .from(documents)
      .leftJoin(chunks, eq(chunks.documentId, documents.id))
      .where(eq(documents.ownerSub, sub))
      .groupBy(documents.id)
      .orderBy(desc(documents.createdAt));

    return Response.json({ documents: rows });
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    const { sub } = await requireUser();

    const form = await request.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return Response.json({ error: "Expected a file field" }, { status: 400 });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return Response.json(
        { error: `File exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` },
        { status: 413 },
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await ingestDocument({
      ownerSub: sub,
      filename: file.name,
      mediaType: file.type || "application/octet-stream",
      bytes,
    });

    return Response.json(result, { status: 201 });
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;

    if (error instanceof UnsupportedFormatError) {
      return Response.json({ error: error.message }, { status: 415 });
    }
    throw error;
  }
}
