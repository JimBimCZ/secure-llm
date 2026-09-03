import { eq, lt, ne } from "drizzle-orm";

import { db } from "@/server/db";
import {
  deploymentSpend,
  documents,
  llmCalls,
  users,
  userSpend,
} from "@/server/db/schema";
import { env } from "@/server/env";
import { logger } from "@/server/log/logger";
import { currentWindowStart } from "@/server/spend";

/**
 * Retention, enforced rather than described (CLAUDE.md §7).
 *
 * A retention policy that lives only in a README is a promise nobody keeps.
 * This runs on startup and then hourly, so the oldest audit record is never
 * more than RETENTION_AUDIT_DAYS plus an hour old, and you can prove it
 * by changing the variable and watching rows disappear.
 *
 * What is NOT purged here, and why:
 *
 * - Documents, chunks and embeddings are kept until the user deletes them.
 *   That is the point of a knowledge base; §7 says "until the user deletes
 *   them", and deletion is immediate and cascading when they do.
 * - Application and auth logs go to stdout. This process does not store them,
 *   so it cannot purge them — retention there belongs to whatever collects the
 *   container's output, and the README says so plainly rather than implying a
 *   job exists that does not.
 * - The anonymization mapping is never written down at all. It lives in one
 *   request's memory and is gone when the request ends, which is why it has no
 *   row in the retention table and no code here.
 */
const HOUR_MS = 60 * 60 * 1000;

export async function purgeExpiredRecords(): Promise<void> {
  const cutoff = new Date(Date.now() - env.RETENTION_AUDIT_DAYS * 24 * HOUR_MS);

  try {
    const deleted = await db
      .delete(llmCalls)
      .where(lt(llmCalls.createdAt, cutoff))
      .returning({ id: llmCalls.id });

    // Logged every run, including the quiet ones: "purged 0" is the evidence
    // the job is alive, and a job that only speaks up when it deletes
    // something is indistinguishable from a job that has silently died.
    logger.info(
      {
        table: "llm_calls",
        purged: deleted.length,
        olderThanDays: env.RETENTION_AUDIT_DAYS,
      },
      "retention purge",
    );
  } catch (error) {
    // Never fatal. A failed purge is an operational problem, not a reason to
    // take the application down.
    logger.error({ err: error }, "retention purge failed");
  }

  // Spend counters keep NOTHING beyond the window they are enforcing. Every row
  // that is not the current window has already done its only job, so it goes —
  // which is what keeps `user_spend` a counter for today rather than a record
  // of how much each person used the app, day by day, going back a month.
  try {
    const deleted = await db
      .delete(userSpend)
      .where(ne(userSpend.windowStart, currentWindowStart()))
      .returning({ sub: userSpend.sub });

    logger.info(
      { table: "user_spend", purged: deleted.length, keeping: "current window" },
      "retention purge",
    );
  } catch (error) {
    logger.error({ err: error }, "spend counter purge failed");
  }

  // The deployment's counter, on exactly the same rule and for the same
  // reason: a row outside the window in force has done its only job. Kept
  // separate from the block above so a failure to purge one does not skip the
  // other.
  try {
    const deleted = await db
      .delete(deploymentSpend)
      .where(ne(deploymentSpend.windowStart, currentWindowStart()))
      .returning({ windowStart: deploymentSpend.windowStart });

    logger.info(
      {
        table: "deployment_spend",
        purged: deleted.length,
        keeping: "current window",
      },
      "retention purge",
    );
  } catch (error) {
    logger.error({ err: error }, "deployment counter purge failed");
  }
}

/**
 * Starts the schedule. Called once, from the startup hook.
 *
 * `unref()` keeps the timer from holding the process open, so a container stop
 * is not delayed by up to an hour waiting for a timer nobody is waiting on.
 */
export function startRetentionSchedule(): void {
  void purgeExpiredRecords();

  const timer = setInterval(() => void purgeExpiredRecords(), HOUR_MS);
  timer.unref();

  logger.info(
    { everyMinutes: 60, auditRetentionDays: env.RETENTION_AUDIT_DAYS },
    "retention schedule started",
  );
}

/**
 * Everything this app holds about one identity, removed.
 *
 * "Delete my account" in §7. Documents cascade to their chunks and embeddings
 * through the foreign key, so this is three statements rather than a careful
 * ordering someone could get wrong later. The `llm_calls` table is deliberately
 * untouched because it holds no subject — there is nothing in it belonging to
 * this person to delete. `user_spend` DOES hold one, so it is deleted here:
 * a table keyed by the subject is a table "delete my account" has to reach.
 * `deployment_spend` is untouched for the `llm_calls` reason — it holds no
 * subject, so there is nothing in it belonging to this person. Their calls
 * stay in the deployment's total, and should: the money was spent, and a
 * ceiling any user could lower the meter on by leaving is not a ceiling.
 */
export async function deleteAccount(ownerSub: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(documents).where(eq(documents.ownerSub, ownerSub));
    await tx.delete(userSpend).where(eq(userSpend.sub, ownerSub));
    await tx.delete(users).where(eq(users.sub, ownerSub));
  });

  logger.info({ sub: ownerSub }, "account deleted");
}
