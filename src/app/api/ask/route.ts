import { z } from "zod";

import { authErrorResponse, requireUser } from "@/server/auth/guard";
import { logger } from "@/server/log/logger";
import { askQuestion } from "@/server/rag/answer";
import { consumeAskQuota } from "@/server/rateLimit";
import { checkDailySpend, type SpendScope } from "@/server/spend";

export const dynamic = "force-dynamic";

/**
 * The two ceilings, in words the person being refused can act on.
 *
 * Naming the shared one matters: telling someone who has asked two questions
 * that they have asked too many is the application stating something false
 * about the reader in order to reveal nothing about anybody else. This reveals
 * only that a shared budget exists and is spent — no user, no count, no times.
 */
const LIMIT_MESSAGE: Record<SpendScope, string> = {
  user: "You have reached today's question limit.",
  deployment: "This deployment has reached today's question limit.",
};

function limitReached(refusal: {
  scope: SpendScope;
  retryAfterSeconds: number;
}): Response {
  return Response.json(
    { error: LIMIT_MESSAGE[refusal.scope] },
    {
      status: 429,
      headers: { "retry-after": String(refusal.retryAfterSeconds) },
    },
  );
}

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

    // The pace is bounded above; this bounds the total. One indexed read,
    // still before the body is read, so a question the ceilings will refuse
    // costs as little as possible. It is an early exit and NOT the control —
    // `reserveCall` in the ask flow is, and it runs again below.
    const budget = await checkDailySpend(sub);
    if (!budget.allowed) {
      logger.warn(
        { sub, scope: budget.scope, outcome: "daily_limit_reached" },
        "ask",
      );
      return limitReached(budget);
    }

    const parsed = askSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json(
        { error: "Ask a question between 3 and 1000 characters." },
        { status: 400 },
      );
    }

    const result = await askQuestion(sub, parsed.data.question);

    // The reservation refused what the pre-check let through: the counter
    // filled in between, which is the race the reservation exists to lose
    // safely.
    if (result.status === "budget_exhausted") return limitReached(result);

    return Response.json(result);
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
