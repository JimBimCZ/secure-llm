import { z } from "zod";

import { authErrorResponse, requireUser } from "@/server/auth/guard";
import { logger } from "@/server/log/logger";
import { askQuestion } from "@/server/rag/answer";
import { consumeAskQuota } from "@/server/rateLimit";

export const dynamic = "force-dynamic";

/** Long enough for a real question, short enough to bound the prompt. */
const askSchema = z.object({
  question: z.string().trim().min(3).max(1_000),
});

/**
 * Ask a question of your own documents.
 *
 * The guard runs first and the subject it returns is the ONLY thing that
 * decides whose documents are searched — the request body cannot name a user.
 */
export async function POST(request: Request) {
  try {
    const { sub } = await requireUser();

    // Before the body is even read: a denied request must cost nothing but the
    // session lookup that identified who to deny.
    const quota = consumeAskQuota(sub);
    if (!quota.allowed) {
      logger.warn({ sub, outcome: "rate_limited" }, "ask");
      return Response.json(
        { error: "Too many questions. Try again in a moment." },
        {
          status: 429,
          headers: { "retry-after": String(quota.retryAfterSeconds) },
        },
      );
    }

    const parsed = askSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json(
        { error: "Ask a question between 3 and 1000 characters." },
        { status: 400 },
      );
    }

    const result = await askQuestion(sub, parsed.data.question);
    return Response.json(result);
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
