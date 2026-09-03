# Shared Spend Ceiling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a daily model-call ceiling for the whole deployment, and replace the per-user cap's racy read-then-write with a single atomic reservation, closing README gaps 13 and 14.

**Architecture:** A call is reserved *before* it is made, by one `INSERT … ON CONFLICT … DO UPDATE SET calls = calls + 1 WHERE calls < $limit RETURNING calls` per counter. No returned row means denied — the reservation *is* the check, so nothing can slip between reading a count and writing it. Both counters are reserved in one short transaction that contains no model call, so the row lock is held for microseconds rather than for a provider's latency. Token totals, known only after the call, are added by a separate best-effort update.

**Tech Stack:** TypeScript, Next.js 16 App Router, Drizzle ORM 0.45.2 on PostgreSQL 17, zod 4, pino, `node --test` with type stripping.

**Spec:** `docs/superpowers/specs/2026-09-03-shared-spend-ceiling-design.md`

## Global Constraints

- **The test suite opens no database connection.** `test/env.ts` points `DATABASE_URL` at `postgres://test:test@127.0.0.1:1/unused` on purpose. A test that needs a database is a test that can pass for the wrong reason. Never add one.
- **No new dependencies.** CLAUDE.md §8: nothing gets added to solve what 30 lines of clear code solves.
- **A new env var goes in five places** or it silently does nothing: `src/server/env.ts` zod schema, `src/server/env.ts` `BUILD_PHASE_PLACEHOLDERS`, `.env.example`, `docker-compose.yaml`, `README.md` configuration table. Slice 12 found this the hard way.
- **Migrations are generated, never hand-written.** `npm run db:generate` writes the `.sql`, the snapshot and the `meta/_journal.json` entry together. `src/server/db/migrate.ts` uses Drizzle's migrator, which reads that journal.
- **Env var name and default, verbatim:** `ASK_DAILY_CALL_LIMIT_TOTAL`, integer, `.min(0)`, `.default(0)`. Zero disables.
- **Refusal copy, verbatim:**
  - `user` scope → `You have reached today's question limit.`
  - `deployment` scope → `This deployment has reached today's question limit.`
- **Every non-trivial decision gets a line in `docs/decisions.md`** in the form `YYYY-MM-DD — <decision> — <why> — <what was rejected>`. Today is `2026-09-03`.
- **Commands:** `npm test`, `npm run typecheck`, `npm run db:generate`.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/server/db/schema.ts` | Add `deploymentSpend` — the subject-free counter | 1 |
| `src/server/db/migrations/0007_deployment_spend.sql` + snapshot + journal | Generated, not written | 1 |
| `src/server/env.ts` | `ASK_DAILY_CALL_LIMIT_TOTAL` in the schema and the build fakes | 1 |
| `.env.example`, `docker-compose.yaml` | The other two of the five places | 1 |
| `src/server/spend.ts` | `reserveCall` (the control), `recordTokens`, scope-aware `checkDailySpend` | 2 |
| `src/server/rag/answer.ts` | Reserve per attempt; new `budget_exhausted` result | 3 |
| `test/answer.test.ts` | The orchestration tests — the only automated coverage of the new path | 3 |
| `src/app/api/ask/route.ts` | Map both refusal sources to the right 429 | 3 |
| `src/server/retention/purge.ts` | Purge the shared counter on the same rule | 4 |
| `src/app/api/admin/stats/route.ts` | Make the ceiling observable | 4 |
| `README.md`, `docs/decisions.md` | Gaps 13/14 rewritten, four new gaps, the decision record | 6 |

---

### Task 1: The table and the variable

**Files:**
- Modify: `src/server/db/schema.ts:214` (append after `export type UserSpend`)
- Create (generated): `src/server/db/migrations/0007_deployment_spend.sql`, `src/server/db/migrations/meta/0007_snapshot.json`, and a new entry in `src/server/db/migrations/meta/_journal.json`
- Modify: `src/server/env.ts:74` (after `ASK_DAILY_CALL_LIMIT`) and `src/server/env.ts:124` (after `ASK_DAILY_CALL_LIMIT: 200,`)
- Modify: `.env.example:144` (after `ASK_DAILY_CALL_LIMIT=200`)
- Modify: `docker-compose.yaml:83` (after `ASK_DAILY_CALL_LIMIT: ${ASK_DAILY_CALL_LIMIT}`)

**Interfaces:**
- Consumes: nothing.
- Produces: `deploymentSpend` (Drizzle `pgTable`, columns `windowStart: Date` primary key, `calls: number`, `inputTokens: number`, `outputTokens: number`), the type alias `DeploymentSpend`, and `env.ASK_DAILY_CALL_LIMIT_TOTAL: number`.

- [ ] **Step 1: Add the table to the schema**

Append to `src/server/db/schema.ts`, after `export type UserSpend = typeof userSpend.$inferSelect;`:

```ts
/**
 * How much the WHOLE DEPLOYMENT has spent in the window in force.
 *
 * `user_spend` above answers "may this person ask another question". This
 * answers "may anyone", which is the number an operator holding a monthly
 * budget actually has.
 *
 * It holds NO subject, and that is a shape rather than a policy: there is
 * nowhere to record who spent it. That is the same control `llm_calls` uses,
 * and it is why `deleteAccount` has nothing to remove here.
 *
 * The obvious alternative — SUM(calls) over `user_spend` — was rejected twice
 * over. An aggregate cannot be atomically checked and incremented, which is
 * the whole mechanism in server/spend.ts; and `deleteAccount` deletes a user's
 * `user_spend` rows, so leaving would refund the deployment's budget.
 */
export const deploymentSpend = pgTable("deployment_spend", {
  /** Start of the UTC day — the same window `user_spend` uses. */
  windowStart: timestamp("window_start", { withTimezone: true })
    .primaryKey()
    .notNull(),
  calls: integer("calls").notNull().default(0),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
});

export type DeploymentSpend = typeof deploymentSpend.$inferSelect;
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`

Expected: a new `src/server/db/migrations/0007_deployment_spend.sql` containing `CREATE TABLE "deployment_spend"`, a new `meta/0007_snapshot.json`, and a seventh entry in `meta/_journal.json` tagged `0007_deployment_spend`.

If drizzle-kit prompts for a migration name, answer `deployment_spend`.

- [ ] **Step 3: Verify the generated SQL says what it should**

Run: `cat src/server/db/migrations/0007_deployment_spend.sql`

Expected: a `CREATE TABLE "deployment_spend"` with `"window_start" timestamp with time zone PRIMARY KEY NOT NULL` and three `integer DEFAULT 0 NOT NULL` columns. If the primary key came out as a separate `CONSTRAINT` line that is fine — what matters is that `window_start` is the key and nothing else is.

- [ ] **Step 4: Add the env var to the zod schema**

In `src/server/env.ts`, immediately after the `ASK_DAILY_CALL_LIMIT` line:

```ts
  // Model calls the WHOLE DEPLOYMENT may make per UTC day, across every user.
  // The limit above bounds one person; this bounds the bill, which is what an
  // operator with a monthly budget actually holds.
  //
  // The default is 0 — DISABLED — and the asymmetry with its sibling is the
  // argument for it. 200 questions per person per day is a personal-scale
  // figure this app can reason about. A deployment total depends on how many
  // people the deployment serves, which this app cannot know, so any non-zero
  // default would be a ceiling the app invented on an operator's behalf and
  // then enforced against them.
  ASK_DAILY_CALL_LIMIT_TOTAL: z.coerce.number().int().min(0).default(0),
```

- [ ] **Step 5: Add it to the build-phase placeholders**

In `src/server/env.ts`, in `BUILD_PHASE_PLACEHOLDERS`, immediately after `ASK_DAILY_CALL_LIMIT: 200,`:

```ts
  ASK_DAILY_CALL_LIMIT_TOTAL: 0,
```

- [ ] **Step 6: Add it to `.env.example`**

After the `ASK_DAILY_CALL_LIMIT=200` block:

```
# Model calls the WHOLE DEPLOYMENT may make per UTC day, across every user.
# The limit above bounds one person; this bounds the bill. Counted in the
# database (table `deployment_spend`, one row per day, purged when the day
# rolls). Default 0 = disabled: how many calls a deployment should afford
# depends on how many people it serves, which the app cannot know, so it does
# not guess on your behalf.
ASK_DAILY_CALL_LIMIT_TOTAL=0
```

- [ ] **Step 7: Add it to the compose file**

In `docker-compose.yaml`, in the `app` service's `environment:` block, immediately after `ASK_DAILY_CALL_LIMIT: ${ASK_DAILY_CALL_LIMIT}`:

```yaml
      ASK_DAILY_CALL_LIMIT_TOTAL: ${ASK_DAILY_CALL_LIMIT_TOTAL}
```

- [ ] **Step 8: Verify nothing broke**

Run: `npm run typecheck && npm test`

Expected: typecheck clean, all existing tests pass. Nothing consumes the new table or variable yet — this step is checking that adding them broke nothing.

- [ ] **Step 9: Commit**

```bash
git add src/server/db/schema.ts src/server/db/migrations src/server/env.ts .env.example docker-compose.yaml
git commit -m "feat(db): a spend counter for the deployment, not just the user

deployment_spend holds no subject, the same control llm_calls uses.
SUM(calls) over user_spend was the tempting alternative and is wrong
twice: an aggregate cannot be atomically checked and incremented, and
deleteAccount removes those rows, so leaving would refund the budget.

ASK_DAILY_CALL_LIMIT_TOTAL defaults to 0, unlike its per-user sibling's
200. How many calls a deployment should afford depends on how many
people it serves, which the app cannot know."
```

---

### Task 2: The reservation

**Files:**
- Modify: `src/server/spend.ts` — whole file, substantially
- Test: `test/spend.test.ts` (existing tests must stay green, unchanged)

**Interfaces:**
- Consumes: `deploymentSpend`, `env.ASK_DAILY_CALL_LIMIT_TOTAL` from Task 1.
- Produces:
  - `export type SpendScope = "user" | "deployment"`
  - `export interface SpendRefusal { allowed: false; scope: SpendScope; retryAfterSeconds: number }`
  - `export type Reservation = { allowed: true } | SpendRefusal`
  - `export async function reserveCall(sub: string, now?: number): Promise<Reservation>`
  - `export async function recordTokens(sub: string, inputTokens: number, outputTokens: number, now?: number): Promise<void>`
  - `export async function checkDailySpend(sub: string, now?: number): Promise<Reservation>` — **return type changed** from the old `SpendDecision`
  - `spendDecision` and `currentWindowStart` keep their existing signatures exactly.
  - `recordSpend` is **removed**.

- [ ] **Step 1: Replace the file header comment**

The old header argues that non-atomicity is acceptable. It is now false. Replace the block comment at the top of `src/server/spend.ts` (everything from `/**` down to the `*/` above `const DAY_MS`) with:

```ts
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
```

- [ ] **Step 2: Update the imports and add the refusal type**

Replace the import block at the top of `src/server/spend.ts` with:

```ts
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { deploymentSpend, userSpend } from "@/server/db/schema";
import { env } from "@/server/env";
import { logger } from "@/server/log/logger";
```

Then, immediately after `const DAY_MS = 24 * 60 * 60 * 1000;`:

```ts
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
  constructor(readonly scope: SpendScope) {
    super(`daily ${scope} limit reached`);
  }
}
```

- [ ] **Step 3: Extract the wait, and keep `spendDecision` behaving identically**

`spendDecision` currently computes the retry-after inline. Two callers need it now. Add above `spendDecision`:

```ts
/**
 * Seconds until the current window rolls.
 *
 * Never zero: a Retry-After of 0 invites an immediate retry that also fails.
 */
function secondsUntilWindowRoll(now: number): number {
  const rollsAt = currentWindowStart(now).getTime() + DAY_MS;

  return Math.max(1, Math.ceil((rollsAt - now) / 1_000));
}
```

and replace the body of `spendDecision`'s refusal branch so the whole function reads:

```ts
export function spendDecision(
  callsSoFar: number,
  limit: number,
  now = Date.now(),
): SpendDecision {
  if (limit === 0) return { allowed: true, retryAfterSeconds: 0 };
  if (callsSoFar < limit) return { allowed: true, retryAfterSeconds: 0 };

  return { allowed: false, retryAfterSeconds: secondsUntilWindowRoll(now) };
}
```

Leave the `SpendDecision` interface and `currentWindowStart` exactly as they are — `test/spend.test.ts` pins both and must not change.

- [ ] **Step 4: Run the existing tests to prove the refactor changed nothing**

Run: `npm test -- --test-name-pattern="spendDecision|currentWindowStart"`

Expected: PASS. If `--test-name-pattern` is awkward with this runner, `npm test` is fine — the whole suite should still be green at this point.

- [ ] **Step 5: Add the deployment counter read, alongside the existing user one**

After `callsUsedInWindow`, add:

```ts
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
```

- [ ] **Step 6: Make `checkDailySpend` scope-aware and demote it in its own docs**

Replace the whole existing `checkDailySpend` function with:

```ts
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
```

- [ ] **Step 7: Replace `recordSpend` with `reserveCall`**

Delete the entire `recordSpend` function and put this in its place:

```ts
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
```

- [ ] **Step 8: Add `recordTokens`**

Immediately after `reserveCall`:

```ts
/**
 * Adds what a completed call cost to both counters.
 *
 * Separate from the reservation because tokens are only known once the
 * provider has answered, and the call itself was charged before it was made.
 * Both rows already exist — `reserveCall` created them — so this is an update,
 * and an update matching nothing is a no-op rather than an error.
 *
 * Like the audit record, a failure to count must never fail the user's
 * question: the answer is already computed and correct. Losing token totals
 * loses reporting, never the ceiling, because the ceiling counts calls.
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
```

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`

Expected: errors ONLY in `src/server/rag/answer.ts` (it still imports the deleted `recordSpend`) and `src/app/api/ask/route.ts` (it reads `budget.retryAfterSeconds` off a type that is now a union). Task 3 fixes both. Any error inside `src/server/spend.ts` itself must be fixed now.

If `setWhere` is rejected by drizzle-orm 0.45.2's types, fall back to `db.execute(sql\`…\`)` for the two upserts — `src/server/rag/bm25.ts` already does that for the same reason. The SQL is what ships either way.

- [ ] **Step 11: Commit**

```bash
git add src/server/spend.ts
git commit -m "feat(spend): the reservation is the check

A call is now reserved before it is made, in one statement per counter,
so nothing can slip between reading a count and writing it. Slice 11
tolerated that race because the requests in flight belonged to one user
and were bounded by their per-minute limit; a counter shared by every
user makes the bound N x 20 and the argument false.

Slice 11 rejected counting before the call because it charges for calls
that then fail. Gap 14 complained that a timed-out call is NOT charged
though it consumed a deadline. Gap 14 is right, so this closes both.

A lock held ACROSS the model call is still rejected. This transaction
holds two indexed upserts and nothing else."
```

---

### Task 3: Spending it, and saying so

**Files:**
- Modify: `src/server/rag/answer.ts:1-10` (imports), `:19-27` (`AskResult`), `:46-64` (`AskDependencies` and `LIVE`), `:120-135` (the retry loop)
- Modify: `src/app/api/ask/route.ts:1-10` (imports), `:40-53` (the budget branch), and the `askQuestion` result handling
- Test: `test/answer.test.ts`

**Interfaces:**
- Consumes: `reserveCall`, `recordTokens`, `Reservation`, `SpendScope` from Task 2.
- Produces: `AskResult` gains `{ status: "budget_exhausted"; scope: SpendScope; retryAfterSeconds: number }`; `AskDependencies` gains `reserveCall: (ownerSub: string) => Promise<Reservation>` and `recordTokens: (ownerSub: string, inputTokens: number, outputTokens: number) => Promise<void>`, and loses `recordSpend`.

- [ ] **Step 1: Write the failing tests**

In `test/answer.test.ts`, add `Reservation` to the imports:

```ts
import type { Reservation } from "@/server/spend";
```

replace the `deps` helper with:

```ts
const deps = (
  chunks: RetrievedChunk[],
  model: { answer: AskDependencies["answer"] },
): AskDependencies => ({
  retrieve: async () => chunks,
  reserveCall: async () => ({ allowed: true }),
  recordTokens: async () => {},
  answer: model.answer,
});
```

and add this `describe` block inside the outer `describe("askQuestion", …)`, after the existing tests and before `describe("anonymization round trip", …)`:

```ts
  /**
   * The two daily ceilings, as the ask flow meets them.
   *
   * The reservation itself is SQL and gets no unit test — see the README's
   * gaps. What IS testable here, because the dependency is injected, is the
   * orchestration around it: that a refused reservation never reaches a
   * provider, that the scope survives to the route which has to name the right
   * ceiling, and that the retry is charged as the second real call it is.
   */
  describe("the daily ceilings", () => {
    it("makes no model call when the reservation is refused", async () => {
      const model = stubModel({ answer: "750 W.", citations: [1] });
      const result = await askQuestion("alice", "q?", {
        ...deps(sources, model),
        reserveCall: async () => ({
          allowed: false,
          scope: "deployment",
          retryAfterSeconds: 3_600,
        }),
      });

      assert.equal(result.status, "budget_exhausted");
      assert.equal(model.calls.length, 0, "a refused call must not be made");
    });

    it("carries the scope out, so the route can name the right ceiling", async () => {
      const model = stubModel({ answer: "750 W.", citations: [1] });
      const result = await askQuestion("alice", "q?", {
        ...deps(sources, model),
        reserveCall: async () => ({
          allowed: false,
          scope: "user",
          retryAfterSeconds: 60,
        }),
      });

      assert.equal(result.status === "budget_exhausted" && result.scope, "user");
      assert.equal(
        result.status === "budget_exhausted" && result.retryAfterSeconds,
        60,
      );
    });

    it("charges the retry separately, and stops when it cannot", async () => {
      // The first attempt is funded and rejected by the citation guard. The
      // second has no budget, so the question ends where that rejection had
      // already left it.
      let reservations = 0;
      const model = stubModel({ answer: "Wrong.", citations: [99] });
      const result = await askQuestion("alice", "q?", {
        ...deps(sources, model),
        // Annotated because a ternary between the two arms of a discriminated
        // union widens `allowed` to `boolean` without it.
        reserveCall: async (): Promise<Reservation> => {
          reservations += 1;
          return reservations === 1
            ? { allowed: true }
            : { allowed: false, scope: "user", retryAfterSeconds: 60 };
        },
      });

      assert.equal(reservations, 2, "the retry is a second real call");
      assert.equal(model.calls.length, 1, "and it was never funded");
      assert.equal(result.status, "not_found");
      assert.equal(
        result.status === "not_found" && result.reason,
        "citations_rejected",
      );
    });

    it("records what each completed call cost", async () => {
      const charged: Array<[number, number]> = [];
      const model = stubModel({ answer: "Wrong.", citations: [99] });

      await askQuestion("alice", "q?", {
        ...deps(sources, model),
        recordTokens: async (_sub, input, output) => {
          charged.push([input, output]);
        },
      });

      // Two attempts, two costs. The stub reports 1 in and 1 out per call.
      assert.deepEqual(charged, [
        [1, 1],
        [1, 1],
      ]);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`

Expected: FAIL — at runtime, not at compile time. `node --test` strips types rather than checking them, so this does **not** surface as a type error. The four new tests fail with `TypeError: deps.recordSpend is not a function` (the loop still calls the member the new `deps` helper no longer supplies), and the existing tests fail the same way. Do not go looking for a compile error; there will not be one until `npm run typecheck` in step 8.

- [ ] **Step 3: Widen `AskResult`**

In `src/server/rag/answer.ts`, replace the `AskResult` union with:

```ts
export type AskResult =
  | {
      status: "answered";
      answer: string;
      citations: Citation[];
      privacy: Privacy;
    }
  /** The honest outcome. `reason` is for the log and the UI's explanation. */
  | { status: "not_found"; reason: "no_relevant_chunks" | "citations_rejected" }
  /**
   * A ceiling had no room for the call. Distinct from `not_found` because
   * nothing was searched and found wanting — the question was never asked.
   * `scope` decides which of the two ceilings the user is told about.
   */
  | {
      status: "budget_exhausted";
      scope: SpendScope;
      retryAfterSeconds: number;
    };
```

- [ ] **Step 4: Swap the dependency**

In `src/server/rag/answer.ts`, change the import line

```ts
import { recordSpend } from "@/server/spend";
```

to

```ts
import {
  recordTokens,
  reserveCall,
  type Reservation,
  type SpendScope,
} from "@/server/spend";
```

Replace the `recordSpend` member of `AskDependencies` with:

```ts
  /** Reserves one model call against both daily ceilings, atomically. THE
   *  control — the route's pre-check is only an early exit. Injected so the
   *  tests, which may not open a connection, do not reach a database. */
  reserveCall: (ownerSub: string) => Promise<Reservation>;
  /** Adds what a completed call cost. Best-effort; never fails a question. */
  recordTokens: (
    ownerSub: string,
    inputTokens: number,
    outputTokens: number,
  ) => Promise<void>;
```

and in `LIVE`, replace `recordSpend,` with:

```ts
  reserveCall,
  recordTokens,
```

- [ ] **Step 5: Reserve before each attempt**

In `src/server/rag/answer.ts`, replace the top of the retry loop — from `for (const retry of [false, true]) {` down to and including the `await deps.recordSpend(…);` call — with:

```ts
  for (const retry of [false, true]) {
    // Reserved BEFORE the call, not counted after it: the reservation IS the
    // check, so nothing can slip between reading a count and writing it. The
    // retry below is a second real call, so it reserves again.
    const reservation = await deps.reserveCall(ownerSub);

    if (!reservation.allowed) {
      if (retry) {
        // The first attempt was rejected by the citation guard and there is no
        // budget for a second. Fall through to the refusal that attempt had
        // already earned — but say so first, because an unfunded retry that
        // vanished from the log is the one budget event nobody could see.
        logger.warn(
          { sub: ownerSub, scope: reservation.scope, outcome: "retry_unfunded" },
          "ask",
        );
        break;
      }

      logger.warn(
        {
          sub: ownerSub,
          scope: reservation.scope,
          outcome: "budget_exhausted",
        },
        "ask",
      );

      return {
        status: "budget_exhausted",
        scope: reservation.scope,
        retryAfterSeconds: reservation.retryAfterSeconds,
      };
    }

    const result = await deps.answer({ ...input, retry });

    // The call was charged above, before it was made. Only its cost is known
    // now, and only now can it be recorded.
    await deps.recordTokens(
      ownerSub,
      result.usage.inputTokens,
      result.usage.outputTokens,
    );
```

Leave everything below — `resolveCitations`, the success branch, the citation-guard warning — exactly as it is.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`

Expected: PASS, all files. The four new tests and every existing one.

- [ ] **Step 7: Say the right sentence in the route**

In `src/app/api/ask/route.ts`, add to the imports:

```ts
import { checkDailySpend, type SpendScope } from "@/server/spend";
```

(replacing the existing `import { checkDailySpend } from "@/server/spend";`)

Add above `export async function POST`:

```ts
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
```

Replace the daily-spend branch with:

```ts
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
```

and replace `return Response.json(result);` with:

```ts
    const result = await askQuestion(sub, parsed.data.question);

    // The reservation refused what the pre-check let through: the counter
    // filled in between, which is the race the reservation exists to lose
    // safely.
    if (result.status === "budget_exhausted") return limitReached(result);

    return Response.json(result);
```

(deleting the now-duplicated `const result = await askQuestion(...)` line above it).

- [ ] **Step 8: Typecheck and test**

Run: `npm run typecheck && npm test`

Expected: both clean. This is the first point since Task 1 at which the whole tree type-checks.

- [ ] **Step 9: Commit**

```bash
git add src/server/rag/answer.ts src/app/api/ask/route.ts test/answer.test.ts
git commit -m "feat(ask): charge a call before making it, and name the ceiling that refused

Each attempt reserves its own call, because the retry is a second real
call and a call is the billable unit. An unfunded retry logs and falls
through to the refusal the first attempt had already earned.

The shared ceiling gets its own sentence. Reusing the personal one would
tell a user who has asked two questions that they have asked too many —
the app stating something false about the reader in order to reveal
nothing about anyone else."
```

---

### Task 4: Purging it, and being able to see it

**Files:**
- Modify: `src/server/retention/purge.ts:1-10` (imports), after the `userSpend` purge block, and the `deleteAccount` comment
- Modify: `src/app/api/admin/stats/route.ts` — whole file

**Interfaces:**
- Consumes: `deploymentSpend` (Task 1), `currentWindowStart` (already exported).
- Produces: `/api/admin/stats` response shape `{ knownUsers: number; today: { calls: number; limit: number } }`.

- [ ] **Step 1: Purge the shared counter on the same rule**

In `src/server/retention/purge.ts`, change the schema import to:

```ts
import {
  deploymentSpend,
  documents,
  llmCalls,
  users,
  userSpend,
} from "@/server/db/schema";
```

and add, immediately after the `user_spend` purge `try/catch` block and before the closing brace of `purgeExpiredRecords`:

```ts
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
```

- [ ] **Step 2: Say why `deleteAccount` does not touch it**

In `src/server/retention/purge.ts`, in the `deleteAccount` block comment, replace the sentence

```
 * `user_spend` DOES hold one, so it is deleted here:
 * a table keyed by the subject is a table "delete my account" has to reach.
```

with:

```
 * `user_spend` DOES hold one, so it is deleted here:
 * a table keyed by the subject is a table "delete my account" has to reach.
 * `deployment_spend` is untouched for the `llm_calls` reason — it holds no
 * subject, so there is nothing in it belonging to this person. Their calls
 * stay in the deployment's total, and should: the money was spent, and a
 * ceiling any user could lower the meter on by leaving is not a ceiling.
```

- [ ] **Step 3: Report the ceiling on the admin endpoint**

Replace `src/app/api/admin/stats/route.ts` entirely with:

```ts
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
```

- [ ] **Step 4: Typecheck and test**

Run: `npm run typecheck && npm test`

Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add src/server/retention/purge.ts src/app/api/admin/stats/route.ts
git commit -m "feat(retention): purge the shared counter, and let an admin see it

deployment_spend keeps nothing beyond the window it enforces, the same
rule user_spend gets. deleteAccount deliberately does not touch it: it
holds no subject, and a departed user's calls stay in the total because
the money was spent.

The admin endpoint reports today's calls and the limit in force. A
ceiling nobody can observe is how ASK_RATE_LIMIT_PER_MINUTE and
ASK_DAILY_CALL_LIMIT each spent a slice pinned to their defaults."
```

---

### Task 5: The measured pass against the running stack

This is the controlling verification. The reservation is SQL, the suite opens no connection, and slice 13's `&&` precedence bug reached the running stack past a green suite. **Nothing in this slice is done until this task produces numbers.**

**Files:** none modified. Record the numbers — they are Task 6's input.

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: measured figures for the README — the observed `deployment_spend.calls` under a burst, the same for `user_spend.calls`, and confirmation that a timed-out call is charged.

- [ ] **Step 1: Bring the stack up with small ceilings**

In `.env` (local, git-ignored — do not commit it):

```
LLM_PROVIDER=mock
ASK_DAILY_CALL_LIMIT=0
ASK_DAILY_CALL_LIMIT_TOTAL=5
ASK_RATE_LIMIT_PER_MINUTE=0
```

`ASK_RATE_LIMIT_PER_MINUTE=0` is deliberate: the per-minute limiter would otherwise mask the very burst this measures.

Run: `docker compose up --build`

Expected: migrations apply including `0007_deployment_spend`, and the app becomes healthy. Confirm with `curl -s localhost:3000/api/health`.

- [ ] **Step 2: Sign in and capture a session cookie**

Sign in through the browser as `alice`, then copy the session cookie into a shell variable so `curl` can act as that user:

```bash
COOKIE='authjs.session-token=<paste the value from devtools>'
```

- [ ] **Step 3: Fire a burst larger than the ceiling**

```bash
for i in $(seq 1 12); do
  curl -s -o /dev/null -w '%{http_code}\n' \
    -X POST localhost:3000/api/ask \
    -H 'content-type: application/json' \
    -H "cookie: $COOKIE" \
    -d '{"question":"what did I write about PSU sizing?"}' &
done; wait
```

Expected: exactly 5 responses of `200` and 7 of `429`. Before this slice the same burst overshoots.

- [ ] **Step 4: Read the counter back**

```bash
docker compose exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c 'select window_start, calls, input_tokens, output_tokens from deployment_spend;'
```

Expected: exactly one row, `calls = 5`. **Write the number down.** If it exceeds 5, the reservation is not atomic and Task 2 is wrong — stop and fix it before going further.

- [ ] **Step 5: Confirm the shared refusal says the shared sentence**

```bash
curl -s -X POST localhost:3000/api/ask \
  -H 'content-type: application/json' -H "cookie: $COOKIE" \
  -d '{"question":"what did I write about PSU sizing?"}'
```

Expected: `{"error":"This deployment has reached today's question limit."}` with status 429 and a `retry-after` header counting seconds to the next UTC midnight.

- [ ] **Step 6: Repeat against the per-user ceiling — this is gap 13**

Set `ASK_DAILY_CALL_LIMIT=5` and `ASK_DAILY_CALL_LIMIT_TOTAL=0`, restart, and repeat steps 3–4 reading `user_spend` instead:

```bash
docker compose exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c 'select sub, calls from user_spend;'
```

Expected: `calls = 5` exactly, and the personal sentence (`You have reached today's question limit.`) on the refusals. **Write the number down** — it is what closes gap 13.

- [ ] **Step 7: Confirm a failed call is charged — this is gap 14**

Set `ASK_DAILY_CALL_LIMIT=5`, `ASK_DAILY_CALL_LIMIT_TOTAL=0` and `LLM_TIMEOUT_MS=1` so every call times out, restart, and ask one question.

Expected: the question fails, `llm_calls` gains a row with outcome `timeout` and zero tokens (as before), **and** `user_spend.calls` is now `1` rather than `0`. Before this slice it stayed `0`. **Write both down.**

- [ ] **Step 8: Confirm the admin view, and the 403**

```bash
curl -s -H "cookie: $ADMIN_COOKIE" localhost:3000/api/admin/stats
curl -s -o /dev/null -w '%{http_code}\n' -H "cookie: $COOKIE" localhost:3000/api/admin/stats
```

Expected: the admin call returns `today.calls` matching the number `psql` reported and `today.limit` matching the configured ceiling; the `alice` call returns `403`.

- [ ] **Step 9: Confirm the purge**

Insert a row for yesterday's window, wait for the hourly job or restart the app, and confirm it is gone while today's survives:

```bash
docker compose exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "insert into deployment_spend (window_start, calls) values (date_trunc('day', now() at time zone 'utc') - interval '1 day', 99);"
docker compose restart app
docker compose exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c 'select window_start, calls from deployment_spend;'
```

Expected: one row, today's. The seeded row for yesterday is gone.

- [ ] **Step 10: Restore your `.env`**

Put `LLM_TIMEOUT_MS`, `ASK_RATE_LIMIT_PER_MINUTE`, `ASK_DAILY_CALL_LIMIT` and `ASK_DAILY_CALL_LIMIT_TOTAL` back to the values you want to keep. `.env` is git-ignored and must not be committed.

There is nothing to commit in this task. Its output is the numbers.

---

### Task 6: The written record

**Files:**
- Modify: `README.md` — the configuration table (`:889`), the spend section (`:730-764`), gaps 13 and 14 (`:1046-1060`), the gap list (append), the roadmap (`:1125` onward), and the "what to try" step at `:141`
- Modify: `docs/decisions.md` — append a slice 15 section
- Modify: `docs/superpowers/specs/2026-09-03-shared-spend-ceiling-design.md` — flip `**Status:** designed` to `**Status:** implemented`, and record any deviation

**Interfaces:**
- Consumes: the measured numbers from Task 5.
- Produces: nothing code depends on.

- [ ] **Step 1: Add the variable to the README configuration table**

After the `ASK_DAILY_CALL_LIMIT` row at `README.md:890`:

```markdown
| `ASK_DAILY_CALL_LIMIT_TOTAL` | `0` | Model calls the whole deployment may make per UTC day, across every user. `0` disables it. Defaults to off because how many calls a deployment should afford depends on how many people it serves, which the app cannot know |
```

- [ ] **Step 2: Rewrite the spend section for two ceilings**

In the section beginning at `README.md:730`, the existing prose introduces two ceilings — pace, then personal total. Extend it to three and add the mechanism. Draft, with `<BURST>` and `<CEILING>` replaced by the numbers Task 5 Step 3 and Step 4 actually produced:

```markdown
`ASK_RATE_LIMIT_PER_MINUTE` bounds the **pace** of one person's spending.
`ASK_DAILY_CALL_LIMIT` bounds their **total**. Neither bounds the **bill**,
which is every user added together, and that is what `ASK_DAILY_CALL_LIMIT_TOTAL`
is for — the number an operator with a monthly budget actually holds.

All three are enforced before a call is made, not counted after it. A call is
**reserved**, by one statement per counter:

    INSERT INTO deployment_spend (window_start, calls) VALUES ($1, 1)
    ON CONFLICT (window_start) DO UPDATE
       SET calls = deployment_spend.calls + 1
     WHERE deployment_spend.calls < $2
    RETURNING calls

Postgres holds a row lock for the duration of that upsert, so the read the
`WHERE` performs and the write it guards cannot be separated by another
transaction. **No returned row means denied.** The reservation *is* the check,
so there is no second step to race against — which is what the previous
read-then-write had, and what gap 13 recorded. Both counters are reserved in
one transaction, the per-user row locked first so the lock order is always the
same, and **no model call happens inside it**: it holds two indexed upserts and
nothing else. A lock held across the provider's latency is still exactly the
thing this refuses to do.

Measured on the running stack: <BURST> concurrent questions against a ceiling
of <CEILING> leave the counter at exactly <CEILING>. The retry the citation
guard is allowed is a second real call, so it reserves again; if there is no
budget for it, the question ends at the refusal the first attempt had already
earned.
```

- [ ] **Step 3: Rewrite gaps 13 and 14 as closed**

Replace the existing gap 13 and gap 14 entries with a single entry recording that both are closed, what closed them, and the correction:

```markdown
13. **~~The daily cap is checked and incremented separately~~ — closed, and it
    took correcting an earlier decision to close it.** A call is now reserved
    before it is made, by one `INSERT … ON CONFLICT … DO UPDATE SET calls =
    calls + 1 WHERE calls < $limit RETURNING calls` per counter: no returned
    row means denied, and the reservation is the check, so there is no second
    step to race against. Measured, 12 concurrent questions against a ceiling
    of 5 leave the counter at exactly 5; before this it overshot.
    Slice 11 had rejected exactly this, on the grounds that counting before the
    call "charges for calls that then fail". Gap 14 below complained about the
    same behaviour from the other side — that a timed-out call is *not*
    charged, though it consumed a deadline and `llm_calls` already records it
    with zero tokens. Both were written the same day and only one could be
    right. Gap 14 was, so one statement closed both, and charging for a failed
    call is the behaviour rather than its price. What is *still* rejected, for
    slice 11's reason unchanged, is a lock held across the model call: this
    transaction holds two indexed upserts and nothing else.
14. **~~A model call that times out or errors is not counted against the daily
    cap~~ — closed as a consequence of 13.** Measured with `LLM_TIMEOUT_MS=1`:
    the call fails, `llm_calls` records it with zero tokens as before, and the
    spend counter now reads 1 where it used to read 0.
```

Use the actual numbers from Task 5 Steps 4, 6 and 7 — if the measurement differed from the expectation, the README says what was measured, not what was expected.

- [ ] **Step 4: Add the four new gaps**

Append to the gap list, numbered from 24:

```markdown
24. **Every question in the deployment contends on one row.** The shared
    counter is a single row and every reservation locks it. Inside a
    transaction holding two indexed upserts and no network call that is
    microseconds, at the personal scale gap 6 already assumes. At real scale it
    is a serialisation point on the hottest path, and the answer there is a
    sharded counter or a budget held by the gateway — which is where gap 8
    already says this control belongs.
25. **A provider failing every call still burns the day's budget.** That is the
    deliberate direction — gap 14 above asked for exactly it — and it has a
    cost: an outage can exhaust the ceiling without a single answer being
    produced. The alternative is a refund path, which is a compensating write
    that can itself fail, and a ceiling that goes generous during an outage is
    the worse of the two.
26. **The shared counter cannot un-count a user who has deleted their account,
    and should not.** "Delete my account" wipes their `user_spend` row; their
    contribution to the deployment's total stays, because the money was spent.
    It is the visible asymmetry between the two tables, and it is written down
    because the instinct on reading §7's promise is that this is a bug. A total
    any user could lower by leaving would not be a ceiling.
27. **No fairness within the shared ceiling.** One user can consume all of it,
    bounded only by their own per-user cap. Fair shares mean per-user quotas
    expressed against the total, which is a larger feature than this one.
```

- [ ] **Step 5: Strike the roadmap item**

In *What I would build next*, remove item 2 ("A shared spend ceiling") from the numbered list, renumber the rest, and add a paragraph in the style of the existing BM25 note — the list is a record of reasoning, and an item that is now built gets corrected in place rather than deleted:

```markdown
**This list used to hold "a shared spend ceiling" as its second item.** It is
now built, and what it cost is worth recording: the item read "and the
reconciliation that gaps 13 and 14 describe", treating that as work attached to
the ceiling. It was the ceiling's precondition. Gap 13's justification —
that the overshoot is bounded by `ASK_RATE_LIMIT_PER_MINUTE` — held only while
the requests racing each other belonged to one user. A counter every user
contends on makes the bound N × 20, against the one ceiling whose whole purpose
is to stand between an operator and a bill.
```

- [ ] **Step 6: Update the demo walkthrough**

At `README.md:141` the walkthrough tells the reader to lower `ASK_DAILY_CALL_LIMIT` and watch the UI say **"You have reached today's question limit."** Append to that step:

```markdown
Then set `ASK_DAILY_CALL_LIMIT_TOTAL=1` instead, restart, ask once as `alice`
and once as `admin`: the second is refused with a different sentence — **"This
deployment has reached today's question limit."** — because a shared budget
spent by someone else is not the reader having asked too many questions, and
the app should not tell them it is.
```

- [ ] **Step 7: Document the admin endpoint's new field**

The README describes `/api/admin/stats` as the endpoint that demonstrates the role split. Add a sentence where it does, saying it now also reports the shared ceiling:

```markdown
It also reports today's shared spend — `today.calls` against `today.limit` —
because a ceiling an operator cannot observe is how `ASK_RATE_LIMIT_PER_MINUTE`
and `ASK_DAILY_CALL_LIMIT` each spent a slice silently pinned to their defaults
in Docker. It names no user, because the table it reads holds none.
```

- [ ] **Step 8: Write the decisions entries**

Append to `docs/decisions.md`, under a new `## Slice 15 — a shared spend ceiling` heading, one entry per decision in the file's established `YYYY-MM-DD — <decision> — <why> — <what was rejected>` form. At minimum:

- The reservation is the check, one statement per counter — because a shared counter makes slice 11's "bounded by the per-minute limit" argument false, N × 20 rather than 20 — rejected `SELECT … FOR UPDATE` again, for slice 11's reason unchanged.
- **The reversal itself**, as its own entry: slice 11's rejection of count-before-the-call and gap 14's complaint are the same sentence with opposite signs, written the same day; gap 14 is right, a call that was made is a call that was made, and `llm_calls` already recorded it — rejected leaving slice 11's decision standing and building past it.
- Both counters in one transaction, user row locked first — consistent lock ordering makes deadlock impossible, and the transaction contains no model call, which is the whole distinction from the lock slice 11 rejected — rejected reserving them independently, which leaves one counter charged for a call the other refused.
- `deployment_spend` as its own subject-free table — rejected a sentinel row in `user_spend`, which breaks that table's stated invariant, and rejected `SUM(calls)` over it, which cannot be atomically checked-and-incremented and which `deleteAccount` would let any user refund by leaving.
- `ASK_DAILY_CALL_LIMIT_TOTAL` defaults to 0 while its sibling defaults to 200 — a per-person figure is one the app can reason about, a deployment total depends on a population it cannot see — rejected a non-zero default, a ceiling invented on the operator's behalf.
- A distinct sentence for the shared refusal — rejected reusing the personal one, which tells a user who asked two questions that they asked too many.
- The reservation SQL has no unit test, again — slice 14's gap 23 reason unchanged, and the controlling verification is the measured burst — rejected a TypeScript reimplementation of the predicate, which tests the copy.

- [ ] **Step 9: Mark the spec implemented**

In `docs/superpowers/specs/2026-09-03-shared-spend-ceiling-design.md`, change `**Status:** designed` to `**Status:** implemented`, and if anything shipped differently from §3–§7, add a short *Deviations, as built* section saying what and why — the slice 14 spec does this and it is the honest habit.

- [ ] **Step 10: Final check**

Run: `npm run typecheck && npm test`

Expected: both clean.

- [ ] **Step 11: Commit**

```bash
git add README.md docs/decisions.md docs/superpowers/specs/2026-09-03-shared-spend-ceiling-design.md
git commit -m "docs: record the shared ceiling, and the decision it reversed

Gaps 13 and 14 close together, because they were the same sentence with
opposite signs. Slice 11 refused to count before the call since that
charges for calls which fail; gap 14 complained that a failed call goes
uncharged though it consumed a deadline. One statement settles both.

Four new gaps in their place: one hot row, an outage that can burn the
budget, a departed user's calls that stay counted, and no fairness
within the shared total."
```

---

## Definition of done

- [ ] `npm run typecheck` and `npm test` clean.
- [ ] Task 5's burst leaves `deployment_spend.calls` at exactly the ceiling, and the same for `user_spend.calls`.
- [ ] A timed-out call is charged.
- [ ] A `user` token still gets 403 from `/api/admin/stats` (CLAUDE.md §9).
- [ ] `ASK_DAILY_CALL_LIMIT_TOTAL` appears in all five places, and setting it in `.env` demonstrably changes behaviour **in Docker** — the slice 12 test.
- [ ] `git log -p` contains no secrets and `.env` is not staged.
