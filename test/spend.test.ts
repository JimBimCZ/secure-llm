import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { currentWindowStart, spendDecision } from "@/server/spend";

/** 2026-09-03T14:30:00Z — mid-window, so the roll is 9h30m away. */
const MIDDAY = Date.UTC(2026, 8, 3, 14, 30, 0);

/**
 * The daily ceiling on what one user can spend.
 *
 * The per-minute limiter bounds the PACE of spending; this bounds its TOTAL.
 * The decision is kept pure and separate from the row it is taken against, so
 * the boundary — the call that is allowed and the one that is not — can be
 * tested without a database, which is the only place a mistake here would be
 * expensive.
 */
describe("spendDecision", () => {
  it("allows a user under the limit", () => {
    assert.equal(spendDecision(4, 5, MIDDAY).allowed, true);
  });

  it("denies the call that would exceed the limit", () => {
    // Five calls already recorded against a limit of five: the sixth is the
    // one that costs money it should not.
    assert.equal(spendDecision(5, 5, MIDDAY).allowed, false);
  });

  it("stays denied once past the limit", () => {
    assert.equal(spendDecision(9, 5, MIDDAY).allowed, false);
  });

  it("treats a limit of zero as disabled", () => {
    const decision = spendDecision(1_000_000, 0, MIDDAY);

    assert.equal(decision.allowed, true);
    assert.equal(decision.retryAfterSeconds, 0);
  });

  it("says how long until the window rolls", () => {
    // 14:30 UTC to the next midnight is 9h30m.
    assert.equal(spendDecision(5, 5, MIDDAY).retryAfterSeconds, 9.5 * 60 * 60);
  });

  it("rounds the wait up, never down to zero", () => {
    // One millisecond before the roll still has to say "try again in a second",
    // because a Retry-After of 0 invites an immediate retry that also fails.
    const almost = Date.UTC(2026, 8, 4, 0, 0, 0) - 1;

    assert.equal(spendDecision(5, 5, almost).retryAfterSeconds, 1);
  });
});

/**
 * The window is a UTC day. One row per user per day, so the table is a counter
 * for today rather than a history of who asked what and when.
 */
describe("currentWindowStart", () => {
  it("starts the window at UTC midnight", () => {
    assert.equal(
      currentWindowStart(MIDDAY).toISOString(),
      "2026-09-03T00:00:00.000Z",
    );
  });

  it("gives the same window for two times on the same day", () => {
    const morning = Date.UTC(2026, 8, 3, 1, 0, 0);

    assert.equal(
      currentWindowStart(morning).getTime(),
      currentWindowStart(MIDDAY).getTime(),
    );
  });

  it("gives a new window after midnight", () => {
    const tomorrow = Date.UTC(2026, 8, 4, 0, 0, 0);

    assert.notEqual(
      currentWindowStart(tomorrow).getTime(),
      currentWindowStart(MIDDAY).getTime(),
    );
  });
});
