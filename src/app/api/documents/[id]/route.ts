import { and, eq } from "drizzle-orm";

import { authErrorResponse, requireUser } from "@/server/auth/guard";
import { db } from "@/server/db";
import { documents } from "@/server/db/schema";
import { logger } from "@/server/log/logger";

export const dynamic = "force-dynamic";

/**
 * Immediate hard delete, cascading to chunks and embeddings (CLAUDE.md §7).
 *
 * The ownership predicate is part of the DELETE itself, so a request for
 * someone else's document deletes nothing and reports 404 — it never reveals
 * whether that id exists.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { sub } = await requireUser();
    const { id } = await params;

    const deleted = await db
      .delete(documents)
      .where(and(eq(documents.id, id), eq(documents.ownerSub, sub)))
      .returning({ id: documents.id });

    if (deleted.length === 0) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    logger.info({ sub, documentId: id }, "document deleted");
    return new Response(null, { status: 204 });
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
