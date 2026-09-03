# Slice 15 — a shared spend ceiling, and the race that had to close with it

**Date:** 2026-09-03
**Status:** designed
**Requirement it serves:** CLAUDE.md §3, *LLM and data* — every call that leaves the process is
bounded and audited. Slices 9 and 11 bounded what **one** user can spend. Nothing bounds what
the **deployment** spends, which is the number an operator with a monthly budget actually holds.
README roadmap item 2.

---

## 1. Why the shared cap forces the race open

The per-user daily cap shipped in slice 11 with its check and its increment deliberately not
atomic. The decision is on the record:

> The check and the increment are deliberately not atomic, and the gap is written into README
> gap 13 — requests in flight at the same instant all read the same count, so a burst can
> overshoot by roughly that number, which `ASK_RATE_LIMIT_PER_MINUTE` already bounds.

That argument is sound and it is about to stop being true. It rests on one step: the requests
racing each other belong to **one user**, so their number is bounded by that user's per-minute
limit — twenty. A ceiling occasionally twenty calls generous costs a fraction of a cent.

A shared counter is contended by **every signed-in user at once**. The bound becomes N × 20 for
N active users, against a ceiling whose entire purpose is to be the last thing between an
operator and a bill. The overshoot scales with the population and the cap scales with nothing.

So this slice cannot add the shared ceiling and leave the counting as it is. Closing gap 13 is
not scope creep attached to the roadmap item; it is the roadmap item's precondition, and it is
a precondition that can be stated rather than felt.

## 2. The correction to slice 11's decision, and gap 14 closing for free

Slice 11 rejected two ways of closing the race:

> rejected `SELECT … FOR UPDATE` and rejected a single `INSERT … RETURNING` that counts before
> the call, which closes the race by charging for calls that then fail.

The first rejection stands and stands for the same reason: a lock held across a model call is a
lock held for the provider's latency, and every question in the deployment would queue behind
it. Nothing here reopens that.

**The second rejection was wrong, and its stated cost is a benefit.** README gap 14 records the
opposite complaint about the same behaviour:

> A model call that times out or errors is not counted against the daily cap. It is counted in
> `llm_calls`, with zero tokens, because it consumed a deadline — but the spend counter only
> increments once a call returns, so a provider failing slowly is bounded by the per-minute
> limit rather than by the daily one.

Gap 14 says a failed call should be charged, because it consumed a deadline. Slice 11 refused
count-before-the-call precisely because it charges for failed calls. The two are the same
sentence with opposite signs, written a few hours apart, and only one of them can be right.

Gap 14 is right. A call that was made is a call that was made; the audit table already records
it with zero tokens for exactly that reason. **One statement therefore closes both gaps**, and
the correction to slice 11's reasoning is the part of this slice worth defending out loud —
the same shape as slice 13 correcting gap 11's justification and slice 14 correcting the
`RAG_MIN_SCORE` precondition, rather than quietly building past either.

## 3. The mechanism

One statement per counter:

```sql
INSERT INTO deployment_spend (window_start, calls)
VALUES ($1, 1)
ON CONFLICT (window_start) DO UPDATE
   SET calls = deployment_spend.calls + 1
 WHERE deployment_spend.calls < $2
RETURNING calls
```

Postgres takes a row lock for the duration of the upsert, so the read the predicate performs and
the write it guards cannot be separated by another transaction. **No returned row means denied**
— when the `WHERE` is false the update is skipped and the statement affects nothing. The
reservation *is* the check; there is no second step to race against.

The insert path takes no predicate, which is correct: the first call of the day is the first
call of the day, and any limit of at least one admits it.

**When a limit is 0 the predicate is omitted and the increment still happens.** A disabled
ceiling should still leave an accurate counter — the admin view of §7 reads it, and a counter
that only works while the cap is on is a counter nobody can trust when it matters.

### Both counters, one transaction

A call is charged to the user and to the deployment. Two rows, two statements, one transaction,
and if either reservation is refused the transaction rolls back — so a denied call never leaves
one counter incremented and the other not.

**The user row is locked before the deployment row, always.** Consistent lock ordering is what
makes deadlock impossible: concurrent requests from different users take disjoint user-row locks
and then queue on the shared row, and there is no ordering in which two transactions each hold
what the other wants.

**No model call happens inside this transaction.** That is the whole distinction from the
`SELECT … FOR UPDATE` slice 11 rejected: the lock is held for two indexed upserts — microseconds
— not for however long a provider takes to answer. The rejection was of holding a lock across
the network call, and this design does not do that.

### Tokens arrive afterwards

`calls` is reserved before the call because that is what the cap counts. Token totals are known
only after the provider returns, so they are added by a separate best-effort update with the
same failure posture `recordSpend` has today: a failure to record tokens is logged and never
fails the user's question, because the answer is already computed and correct.

## 4. Where the shared counter lives

A new table:

```sql
CREATE TABLE "deployment_spend" (
    "window_start"  timestamp with time zone PRIMARY KEY,
    "calls"         integer DEFAULT 0 NOT NULL,
    "input_tokens"  integer DEFAULT 0 NOT NULL,
    "output_tokens" integer DEFAULT 0 NOT NULL
);
```

Migration `0007_deployment_spend.sql`, same style as `0005_user_spend.sql`.

**It holds no subject.** Not as a policy that could be relaxed but as a shape with nowhere to put
one — the same control `llm_calls` uses, and the reason `deleteAccount` does not need to reach
it (§6).

Two alternatives, both rejected, and the second is the tempting one:

- **A sentinel row in `user_spend`** — a reserved `sub` such as `*`. Rejected: it breaks the
  invariant that table's own documentation states ("ONE row per user per window"), and every
  query keyed by subject would need to remember to exclude it. A table whose correctness depends
  on every future reader knowing about a magic value is a table that will be read wrong.
- **`SUM(calls)` over `user_spend` for the window** — no new table at all. Rejected twice over.
  An aggregate cannot be atomically checked-and-incremented, which is the whole mechanism of §3.
  And `deleteAccount` deletes that user's `user_spend` rows in the same transaction as their
  documents, so **deleting your account would refund the deployment's budget** — a spend ceiling
  that any user can lower the meter on by leaving.

## 5. Configuration

`ASK_DAILY_CALL_LIMIT_TOTAL`, integer, minimum 0, **default 0 (disabled)**.

The asymmetry with its sibling is deliberate and is the argument for the number. `ASK_DAILY_CALL_LIMIT`
defaults to 200 because 200 questions per person per day is a defensible personal-scale figure
that the app can reason about. A *deployment* total depends on how many people the deployment
serves, which this app cannot know, so any non-zero default would be a ceiling the app invented
on an operator's behalf and then enforced against them. Off until asked for.

Five places, because slice 12 found out the hard way that four is not enough and a variable
present in the schema but absent from the compose file is precisely the "variable that silently
does nothing" CLAUDE.md §8 forbids:

1. `src/server/env.ts` — the zod schema, with the reasoning above in the comment
2. `src/server/env.ts` — the build-phase fake values
3. `.env.example`
4. `docker-compose.yaml` — the `app` service environment block
5. `README.md` — the configuration table

## 6. What changes, file by file

### `src/server/db/schema.ts`

Adds `deploymentSpend`, documented against `userSpend` — the difference in shape is the whole
privacy argument and belongs next to both.

### `src/server/spend.ts`

Unchanged and still pure: `spendDecision`, `currentWindowStart`. Their tests stay as they are.

- **`reserveCall(sub, now)`** → `{ allowed: true } | { allowed: false; scope: "user" | "deployment"; retryAfterSeconds: number }`.
  The transaction of §3. This is the control. `retryAfterSeconds` comes from the existing
  `spendDecision` arithmetic for either scope, because both windows are the same UTC day and
  both roll at the same midnight — a shared ceiling does not get a clock of its own.
- **`recordTokens(sub, inputTokens, outputTokens, now)`** — best-effort, both rows, never throws.
- **`checkDailySpend(sub, now)`** — kept, now reporting which ceiling is exhausted, and
  **demoted in its own documentation**: it is a cheap pre-body rejection so a denied question
  costs one indexed read rather than a parsed body, and it is explicitly no longer the thing
  that enforces anything. Leaving it undocumented as an optimisation would leave two functions
  that look like the control with only one that is.
- **`recordSpend`** is removed. Its job is now split across the two functions above.

Drizzle's `onConflictDoUpdate` takes a `setWhere`; if it does not emit the predicate this design
needs, the fallback is `db.execute(sql\`…\`)`, which `rag/bm25.ts` already uses for the same
reason. Either way the SQL is what ships and the SQL is what gets verified (§8).

### `src/server/rag/answer.ts`

`AskDependencies` swaps `recordSpend` for `reserveCall` and `recordTokens`. Both stay injected,
for the reason slice 11 injected the first: the test suite must not open a database connection.

The retry loop reserves before **each** attempt, because the retry is a second real call and a
call is the billable unit:

- **First reservation denied** → return `{ status: "budget_exhausted", scope, retryAfterSeconds }`
  and make no provider call. Retrieval and anonymization have already run by this point, since
  the loop sits below both. That work is wasted, and deliberately so: moving the reservation
  above retrieval would charge a call for a question that retrieval was about to refuse for
  free. The route's pre-body `checkDailySpend` is what spares the common case; reaching this
  branch means the counter filled between that read and this reservation, which is the race
  itself and is expected to be rare.
- **Retry reservation denied** → log it with a distinct outcome and break, landing on the
  existing `citations_rejected` return. That question was already heading there; the retry is a
  best-effort improvement, not a promise, and an unfunded retry that vanished from the log would
  be the one budget event nobody could see.

`AskResult` gains the `budget_exhausted` variant.

### `src/app/api/ask/route.ts`

`consumeAskQuota` unchanged and still first — it is in-memory and cheaper than a query.
`checkDailySpend` then picks the message by scope, and a `budget_exhausted` result from
`askQuestion` maps to the same two 429s:

| Scope | Message |
| --- | --- |
| `user` | `You have reached today's question limit.` (unchanged) |
| `deployment` | `This deployment has reached today's question limit.` |

The shared message names a shared budget and nothing else — no user, no count, no timing. The
alternative, one message for both, was rejected: it would tell a user who has asked two
questions that they have asked too many, which is the application stating something false about
the reader in order to reveal nothing about anybody else.

**No UI change.** `ask-form.tsx:57` already renders `payload.error` from a non-OK response, and
the UI never sees a 200 carrying `budget_exhausted`.

### `src/server/retention/purge.ts`

`deployment_spend` rows outside the current window are deleted on the same schedule and for the
same reason as `user_spend`: a row that is not the window in force has done its only job.

`deleteAccount` **does not touch it**, and the comment says why in the words already used for
`llm_calls` — it holds no subject, so there is nothing in it belonging to this person to delete.

### `src/app/api/admin/stats/route.ts`

Reports the current window's `calls` and the limit in force alongside `knownUsers`. One row,
admin-only, already role-guarded. A ceiling an operator cannot observe is the failure mode slice
12 recorded: a control that is documented, tested, defended, and inert in the only environment
anyone runs.

## 7. New gaps this opens

Written here so they are designed rather than discovered, and they go to the README on landing:

1. **Every question in the deployment contends on one row.** The shared counter is a single row
   and every reservation locks it. At personal scale that is microseconds inside an already-short
   transaction. At real scale it is a serialisation point on the app's hottest path, and the
   answer there is a sharded counter or a budget held by the gateway — which is where README gap
   8 already says this control belongs.
2. **A provider failing every call still burns the day's budget.** That is the deliberate
   direction (§2) and it has a cost: a provider outage can exhaust the cap without a single
   answer being produced. The alternative is a refund path, which is a compensating write that
   can itself fail, and a cap that is wrong in the generous direction during an outage is the
   worse of the two.
3. **The shared counter cannot un-count a departed user, and should not.** `deleteAccount` wipes
   their `user_spend` row; their contribution to the deployment total stays. The money was spent.
   This is the visible asymmetry between the two tables and it is worth stating, because the
   instinct on reading "delete everything belonging to the subject" is that this is a bug.
4. **No fairness within the shared cap.** One user can consume all of it, and the per-user cap
   only bounds them at its own limit. Fair shares need per-user quotas expressed against the
   total, which is a different feature and a bigger one.

## 8. Verification

Stated before the work rather than promised and dropped, which is the lesson of slice 14's
gap 23.

**Unit tests (no database connection, per the suite's standing rule):**

- `spendDecision` and `currentWindowStart` — unchanged, still the pure boundary.
- **New, and a real one:** the ask flow's behaviour under a denied reservation, reachable
  because `AskDependencies` is injected. A stub denying the first reservation must produce
  `budget_exhausted` with **zero** provider calls; a stub denying only the second must stop at
  **exactly one**, and land on `citations_rejected`.

**No unit test for the reservation SQL,** for slice 14's reason unchanged: the suite opens no
connection, and a TypeScript reimplementation of the predicate would test the copy rather than
the query — which is exactly how slice 13's `&&` precedence bug reached the running stack past a
green suite.

**The controlling verification is a measured concurrency pass against the running stack**, and
it is the point of the slice rather than a formality:

1. `ASK_DAILY_CALL_LIMIT=0`, `ASK_DAILY_CALL_LIMIT_TOTAL=5`, `LLM_PROVIDER=mock`.
2. Fire more simultaneous `/api/ask` requests than the cap allows, from more than one user.
3. Assert `deployment_spend.calls` for the window is **exactly 5** and that the surplus requests
   returned 429 with the shared message. Before this slice the same pass overshoots.
4. Repeat with the per-user cap to confirm gap 13 is closed on the counter it was written about.
5. Force a provider timeout and confirm the call **is** charged — gap 14, closed.
6. Confirm the admin endpoint reports the same number the table holds, and 403s for a `user`
   token.

The numbers from that pass go in the README, replacing the gap 13 and gap 14 text.

## 9. Documentation on landing

- `README.md` — gaps 13 and 14 rewritten as closed, with what closing them cost; the four gaps
  of §7 added; the spend section rewritten to describe two ceilings; the configuration table;
  roadmap item 2 struck and its reasoning corrected in place rather than deleted.
- `docs/decisions.md` — a slice 15 section, including the correction to slice 11's rejection of
  count-before-the-call as its own entry, since reversing a recorded decision is the thing that
  file exists to capture.
