import { and, eq, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { userSpend } from "@/server/db/schema";
import { env } from "@/server/env";
import { logger } from "@/server/log/logger";

/**
 * A daily ceiling on what one user can spend on model calls.
 *
 * `rateLimit.ts` bounds the PACE of spending — twenty questions a minute. It
 * does nothing about a user who asks nineteen questions a minute all day, which
 * is the same bill arriving more slowly. This bounds the TOTAL.
 *
 * WHY THIS IS NOT COUNTED IN `llm_calls`. That table deliberately holds no
 * subject: it answers "what did this app spend and how did it behave", and
 * adding an owner would turn a cost-and-latency table into a 30-day
 * behavioural log of every user's questions (see db/schema.ts). A ceiling does
 * not need that. It needs one number per user for the window in force, so that
 * is all this stores: a running total, updated in place, with no per-call row,
 * no ordering and no per-question timestamp. Nothing here can be read back as
 * "what did this person ask, and when".
 *
 * The window is a UTC day, and the retention job deletes every row that is not
 * the current window — so within the hour the table holds at most one row per
 * user, for today. It is a counter, not a history. That is the whole
 * difference between this and the thing the audit table refused to become.
 *
 * The honest limitation is that the check and the increment are not one atomic
 * operation: the count is read when the request arrives and incremented when
 * the model answers, so simultaneous requests can overshoot the cap by roughly
 * the number of them in flight. The per-minute limiter already bounds that
 * number, and a ceiling that is occasionally one call generous is a much
 * smaller problem than one that takes a lock on every question.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SpendDecision {
  allowed: boolean;
  /** Seconds until the window rolls. Only meaningful when denied. */
  retryAfterSeconds: number;
}

/**
 * The start of the UTC day containing `now`.
 *
 * UTC rather than the user's timezone: the server cannot know theirs, and a
 * window that moves with whoever is asking is a window that can be reset by
 * changing a clock.
 */
export function currentWindowStart(now = Date.now()): Date {
  const at = new Date(now);

  return new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
  );
}

/**
 * Whether a user who has already made `callsSoFar` calls may make one more.
 *
 * Pure, and separate from the row it is taken against, so the boundary that
 * matters — the call that is allowed and the one that is not — is testable
 * without a database.
 */
export function spendDecision(
  callsSoFar: number,
  limit: number,
  now = Date.now(),
): SpendDecision {
  if (limit === 0) return { allowed: true, retryAfterSeconds: 0 };
  if (callsSoFar < limit) return { allowed: true, retryAfterSeconds: 0 };

  const rollsAt = currentWindowStart(now).getTime() + DAY_MS;

  return {
    allowed: false,
    // Never zero: a Retry-After of 0 invites an immediate retry that also fails.
    retryAfterSeconds: Math.max(1, Math.ceil((rollsAt - now) / 1_000)),
  };
}

/**
 * How many model calls `sub` has made in the window in force.
 *
 * Reads the counter, nothing more. A missing row means a user who has not
 * asked anything today, which is zero.
 */
export async function callsUsedInWindow(
  sub: string,
  now = Date.now(),
): Promise<number> {
  const [row] = await db
    .select({ calls: userSpend.calls })
    .from(userSpend)
    .where(
      and(
        eq(userSpend.sub, sub),
        eq(userSpend.windowStart, currentWindowStart(now)),
      ),
    );

  return row?.calls ?? 0;
}

/**
 * Whether `sub` may make one more model call today.
 *
 * Called from the route, before the request body is read, so a denied question
 * costs one indexed lookup and nothing else.
 */
export async function checkDailySpend(
  sub: string,
  now = Date.now(),
): Promise<SpendDecision> {
  const limit = env.ASK_DAILY_CALL_LIMIT;
  if (limit === 0) return { allowed: true, retryAfterSeconds: 0 };

  return spendDecision(await callsUsedInWindow(sub, now), limit, now);
}

/**
 * Adds one call, and what it cost, to `sub`'s counter for the window.
 *
 * An upsert, so the row is created on the day's first question and incremented
 * by every one after it — the increment happens in Postgres rather than in a
 * read-modify-write here, which would lose concurrent calls outright rather
 * than merely being approximate about them.
 *
 * Like the audit record, a failure to count must never fail the user's
 * question: the answer is already computed and correct. Losing a count errs
 * towards letting someone ask one more question, which is the safe direction
 * for a ceiling to be wrong in, and it is logged so the loss is visible.
 */
export async function recordSpend(
  sub: string,
  inputTokens: number,
  outputTokens: number,
  now = Date.now(),
): Promise<void> {
  try {
    await db
      .insert(userSpend)
      .values({
        sub,
        windowStart: currentWindowStart(now),
        calls: 1,
        inputTokens,
        outputTokens,
      })
      .onConflictDoUpdate({
        target: [userSpend.sub, userSpend.windowStart],
        set: {
          calls: sql`${userSpend.calls} + 1`,
          inputTokens: sql`${userSpend.inputTokens} + ${inputTokens}`,
          outputTokens: sql`${userSpend.outputTokens} + ${outputTokens}`,
        },
      });
  } catch (error) {
    logger.error({ err: error, sub }, "failed to record spend");
  }
}
