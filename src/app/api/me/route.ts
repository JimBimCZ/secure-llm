import { authErrorResponse, requireUser } from "@/server/auth/guard";
import { deleteAccount } from "@/server/retention/purge";

export const dynamic = "force-dynamic";

/** Any signed-in caller. Shows what the guard actually resolved. */
export async function GET() {
  try {
    const principal = await requireUser();
    return Response.json(principal);
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

/**
 * "Delete my account" (CLAUDE.md §7).
 *
 * The subject comes from the guard, never from the request, so this endpoint
 * can only ever delete the caller's own data — there is no parameter to
 * tamper with. Documents cascade to chunks and embeddings.
 *
 * The session is not invalidated here and does not need to be: the token is
 * the IdP's statement about who signed in, which remains true, and the next
 * sign-in simply re-creates an empty account. The client signs out after.
 */
export async function DELETE() {
  try {
    const { sub } = await requireUser();
    await deleteAccount(sub);
    return new Response(null, { status: 204 });
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
