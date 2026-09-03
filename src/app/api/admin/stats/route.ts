import { count, eq } from "drizzle-orm";

import { authErrorResponse, requireRole } from "@/server/auth/guard";
import { db } from "@/server/db";
import { deploymentSpend, users } from "@/server/db/schema";
import { env } from "@/server/env";
import { currentWindowStart } from "@/server/spend";

export const dynamic = "force-dynamic";

/**
 * Admin-only. Exists to make the role split demonstrable: calling this with a
 * `user` token must return 403 from the server, with no UI involved.
 *
 * It also reports today's shared spend, because a ceiling an operator cannot
 * observe is the failure mode slice 12 recorded — a control that is
 * documented, tested, defended, and inert in the only environment anyone runs.
 * One row, and it names no user, because the table it reads holds none.
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

  const [spend] = await db
    .select({
      calls: deploymentSpend.calls,
      inputTokens: deploymentSpend.inputTokens,
      outputTokens: deploymentSpend.outputTokens,
    })
    .from(deploymentSpend)
    .where(eq(deploymentSpend.windowStart, currentWindowStart()));

  return Response.json({
    knownUsers: row?.total ?? 0,
    today: {
      calls: spend?.calls ?? 0,
      inputTokens: spend?.inputTokens ?? 0,
      outputTokens: spend?.outputTokens ?? 0,
      // 0 means the ceiling is off, which is what the variable means.
      limit: env.ASK_DAILY_CALL_LIMIT_TOTAL,
    },
  });
}
