import { count } from "drizzle-orm";

import { authErrorResponse, requireRole } from "@/server/auth/guard";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";

export const dynamic = "force-dynamic";

/**
 * Admin-only. Exists to make the role split demonstrable: calling this with a
 * `user` token must return 403 from the server, with no UI involved.
 */
export async function GET() {
  try {
    await requireRole("admin");
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const [row] = await db.select({ total: count() }).from(users);

  return Response.json({ knownUsers: row?.total ?? 0 });
}
