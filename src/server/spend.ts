import { and, eq, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { deploymentSpend, userSpend } from "@/server/db/schema";
import { env } from "@/server/env";
import { logger } from "@/server/log/logger";

/**
 * The two daily ceilings on what model calls may be made.
 *
 * `rateLimit.ts` bounds the PACE of one user's spending — twenty questions a
 * minute. It does nothing about a user who asks nineteen a minute all day,
 * which is the same bill arriving more slowly. These bound the TOTAL: one per
 * user, and one across the whole deployment, which is the number an operator
 * with a monthly budget actually holds.
 *
 * WHY THIS IS NOT COUNTED IN `llm_calls`. That table deliberately holds no
 * subject: it answers "what did this app spend and how did it behave", and
 * adding an owner would turn a cost-and-latency table into a 30-day
 * behavioural log of every user's questions (see db/schema.ts). A ceiling does
 * not need that. `user_spend` keeps one number per user for the window in
 * force — no per-call row, no ordering, no per-question timestamp — and
 * `deployment_spend` keeps no subject at all. The retention job deletes every
 * row outside the current window, so within the hour these hold at most one
 * row per user for today, plus one for the deployment. Counters, not history.
 *
 * WHY THE RESERVATION IS THE CHECK. Slice 11 read the count when a request
 * arrived and wrote it after the model answered, and accepted the race on the
 * grounds that the requests in flight belong to ONE user, so the overshoot is
 * bounded by that user's per-minute limit. A counter shared by every user
 * breaks that argument outright: the bound becomes N x 20 for N active users,
 * against the one ceiling whose whole job is to stand between an operator and
 * a bill.
 *
 * So a call is reserved BEFORE it is made, in one statement per counter —
 * `INSERT … ON CONFLICT … DO UPDATE SET calls = calls + 1 WHERE calls < limit
 * RETURNING calls`. Postgres holds a row lock for the duration of that upsert,
 * so the read the predicate performs and the write it guards cannot be
 * separated by another transaction. No returned row means denied. There is no
 * second step to race against.
 *
 * SLICE 11 REJECTED THIS, and its stated reason was that counting before the
 * call "charges for calls that then fail". README gap 14 recorded the opposite
 * complaint about the same behaviour: that a timed-out call is NOT charged
 * though it consumed a deadline, which is why `llm_calls` already records it
 * with zero tokens. Both cannot be right. Gap 14 is: a call that was made is a
 * call that was made. So this closes both gaps, and charging for a failed call
 * is the behaviour, not the price.
 *
 * A lock held ACROSS the model call is still rejected, for slice 11's reason —
 * that is the provider's latency spent queueing every other question behind
 * it. The transaction below contains two indexed upserts and nothing else.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Which ceiling refused. It decides which sentence the user is shown. */
export type SpendScope = "user" | "deployment";

export interface SpendRefusal {
  allowed: false;
  scope: SpendScope;
  /** Seconds until the window rolls. */
  retryAfterSeconds: number;
}

export type Reservation = { allowed: true } | SpendRefusal;

/**
 * Thrown inside the reservation transaction to roll it back and carry out
 * WHICH ceiling refused — `tx.rollback()` cannot return a value, and a
 * variable assigned in the callback is not narrowed by TypeScript outside it.
 * Private: nothing beyond this module should catch it.
 */
class Refused extends Error {
  readonly scope: SpendScope;

  constructor(scope: SpendScope) {
    super(`daily ${scope} limit reached`);
    this.scope = scope;
  }
}

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
 * Seconds until the current window rolls.
 *
 * Never zero: a Retry-After of 0 invites an immediate retry that also fails.
 */
function secondsUntilWindowRoll(now: number): number {
  const rollsAt = currentWindowStart(now).getTime() + DAY_MS;

  return Math.max(1, Math.ceil((rollsAt - now) / 1_000));
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

  return { allowed: false, retryAfterSeconds: secondsUntilWindowRoll(now) };
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
 * How many model calls the whole deployment has made in the window in force.
 *
 * A missing row means a day on which nobody has asked anything, which is zero.
 */
export async function callsUsedByDeployment(now = Date.now()): Promise<number> {
  const [row] = await db
    .select({ calls: deploymentSpend.calls })
    .from(deploymentSpend)
    .where(eq(deploymentSpend.windowStart, currentWindowStart(now)));

  return row?.calls ?? 0;
}

/**
 * Whether `sub` may make one more model call today, as far as a plain read can
 * tell.
 *
 * This is NOT the control. `reserveCall` is. This exists so that a request the
 * ceilings are going to refuse costs one indexed read rather than a parsed
 * body and a retrieval pass — it is an early exit, and it is racy, and neither
 * matters because nothing depends on it being right. Anything it lets through
 * is refused again, atomically, at the moment a call is actually made.
 *
 * Checked in the order the reservation takes its locks, so the two agree about
 * which ceiling a user hears about first.
 */
export async function checkDailySpend(
  sub: string,
  now = Date.now(),
): Promise<Reservation> {
  const userLimit = env.ASK_DAILY_CALL_LIMIT;
  if (userLimit > 0) {
    const decision = spendDecision(
      await callsUsedInWindow(sub, now),
      userLimit,
      now,
    );

    if (!decision.allowed) {
      return {
        allowed: false,
        scope: "user",
        retryAfterSeconds: decision.retryAfterSeconds,
      };
    }
  }

  const totalLimit = env.ASK_DAILY_CALL_LIMIT_TOTAL;
  if (totalLimit > 0) {
    const decision = spendDecision(
      await callsUsedByDeployment(now),
      totalLimit,
      now,
    );

    if (!decision.allowed) {
      return {
        allowed: false,
        scope: "deployment",
        retryAfterSeconds: decision.retryAfterSeconds,
      };
    }
  }

  return { allowed: true };
}

/**
 * Reserves one model call against both ceilings, atomically. THE control.
 *
 * One statement per counter, each its own check-and-increment, both inside one
 * transaction so a refusal by either leaves neither incremented. The user's
 * row is locked FIRST, always: consistent lock ordering is what makes deadlock
 * impossible, since concurrent requests take disjoint user-row locks and only
 * then queue on the one row they share.
 *
 * A limit of 0 disables the ceiling but NOT the counting — the predicate is
 * omitted and the increment still happens. A counter that only works while the
 * cap is on is a counter nobody can trust when it is turned on.
 *
 * Unlike `recordTokens` below, a failure here is NOT swallowed. This runs
 * before the call, so throwing costs nothing but the question; swallowing it
 * would make an unreachable database mean an unbounded bill.
 */
export async function reserveCall(
  sub: string,
  now = Date.now(),
): Promise<Reservation> {
  const windowStart = currentWindowStart(now);
  const userLimit = env.ASK_DAILY_CALL_LIMIT;
  const totalLimit = env.ASK_DAILY_CALL_LIMIT_TOTAL;

  try {
    await db.transaction(async (tx) => {
      const user = await tx
        .insert(userSpend)
        .values({ sub, windowStart, calls: 1 })
        .onConflictDoUpdate({
          target: [userSpend.sub, userSpend.windowStart],
          set: { calls: sql`${userSpend.calls} + 1` },
          // Omitted entirely when the ceiling is off, so the row still counts.
          ...(userLimit > 0
            ? { setWhere: sql`${userSpend.calls} < ${userLimit}` }
            : {}),
        })
        .returning({ calls: userSpend.calls });

      // The predicate was false, so the update was skipped and no row came
      // back. That is the refusal.
      if (user.length === 0) throw new Refused("user");

      const deployment = await tx
        .insert(deploymentSpend)
        .values({ windowStart, calls: 1 })
        .onConflictDoUpdate({
          target: deploymentSpend.windowStart,
          set: { calls: sql`${deploymentSpend.calls} + 1` },
          ...(totalLimit > 0
            ? { setWhere: sql`${deploymentSpend.calls} < ${totalLimit}` }
            : {}),
        })
        .returning({ calls: deploymentSpend.calls });

      if (deployment.length === 0) throw new Refused("deployment");
    });
  } catch (error) {
    // Only a refusal is an answer. Anything else is a broken database and must
    // not be reported as "you have asked too many questions".
    if (!(error instanceof Refused)) throw error;

    return {
      allowed: false,
      scope: error.scope,
      retryAfterSeconds: secondsUntilWindowRoll(now),
    };
  }

  return { allowed: true };
}

/**
 * Adds what a completed call cost to both counters.
 *
 * Separate from the reservation because tokens are only known once the
 * provider has answered, and the call itself was charged before it was made.
 * Both rows normally already exist — `reserveCall` created them — so this is
 * an update, and an update matching nothing is a no-op rather than an error.
 * The exception is a call that straddles UTC midnight: this recomputes the
 * window from answer time, so a call reserved at 23:59:58 and answered four
 * seconds later updates the NEXT day's rows — which either matches nothing
 * and loses the token totals, or, if another reservation has already
 * created that window's rows, matches them and adds the totals to the NEXT
 * window's count instead. The CEILING is unaffected either way, because the
 * ceiling counts calls and the call was already charged; only where the
 * token totals land is in question, which is the direction this function is
 * already willing to be wrong in.
 *
 * Like the audit record, a failure to count must never fail the user's
 * question: the answer is already computed and correct. Misplaced token
 * totals cost reporting, never the ceiling, because the ceiling counts
 * calls.
 */
export async function recordTokens(
  sub: string,
  inputTokens: number,
  outputTokens: number,
  now = Date.now(),
): Promise<void> {
  const windowStart = currentWindowStart(now);

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(userSpend)
        .set({
          inputTokens: sql`${userSpend.inputTokens} + ${inputTokens}`,
          outputTokens: sql`${userSpend.outputTokens} + ${outputTokens}`,
        })
        .where(
          and(
            eq(userSpend.sub, sub),
            eq(userSpend.windowStart, windowStart),
          ),
        );

      await tx
        .update(deploymentSpend)
        .set({
          inputTokens: sql`${deploymentSpend.inputTokens} + ${inputTokens}`,
          outputTokens: sql`${deploymentSpend.outputTokens} + ${outputTokens}`,
        })
        .where(eq(deploymentSpend.windowStart, windowStart));
    });
  } catch (error) {
    logger.error({ err: error, sub }, "failed to record token totals");
  }
}
