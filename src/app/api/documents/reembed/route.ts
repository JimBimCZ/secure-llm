import { authErrorResponse, requireUser } from "@/server/auth/guard";
import { reembedStaleDocuments } from "@/server/rag/reembed";

export const dynamic = "force-dynamic";

/**
 * Rebuild the caller's documents against the embedding model now in force.
 *
 * The subject comes from the guard, never from the request: this endpoint takes
 * no body and there is no parameter that could point it at another user's
 * corpus. It is a POST because it rewrites rows, and it is deliberately manual
 * — nothing re-embeds on startup, because rewriting every index because an
 * environment variable changed is the kind of invisible action a mistyped
 * variable would make expensive.
 *
 * The path is static, so Next matches it ahead of `/api/documents/[id]`. That
 * route only ever receives a document id, which is a UUID, so the two cannot
 * collide over a real request.
 */
export async function POST() {
  try {
    const { sub } = await requireUser();
    const result = await reembedStaleDocuments(sub);
    return Response.json(result);
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
