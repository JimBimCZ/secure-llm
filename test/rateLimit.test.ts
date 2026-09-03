import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

type ConsumeAskQuota = typeof import("@/server/rateLimit").consumeAskQuota;

/**
 * The quota that stands between one signed-in user and an unbounded model
 * bill. Three per minute here; the app's default is in `.env.example`.
 */
describe("consumeAskQuota", () => {
  let consume: ConsumeAskQuota;

  before(async () => {
    // Set before `env` is first imported: the schema reads the environment
    // once, at module load.
    process.env.ASK_RATE_LIMIT_PER_MINUTE = "3";
    ({ consumeAskQuota: consume } = await import("@/server/rateLimit"));
  });

  it("allows a user up to the limit", () => {
    const now = 1_000_000;

    for (let i = 0; i < 3; i++) {
      assert.equal(consume("alice", now).allowed, true, `question ${i + 1}`);
    }
  });

  it("denies the one after that, and says when to come back", () => {
    const decision = consume("alice", 1_000_000);

    assert.equal(decision.allowed, false);
    assert.equal(decision.retryAfterSeconds, 60);
  });

  it("counts each user separately", () => {
    // Otherwise one busy user silences everyone else on the instance.
    assert.equal(consume("bob", 1_000_000).allowed, true);
  });

  it("rounds the wait up, never down to zero", () => {
    // 500 ms left is still a wait. Advertising 0 invites an immediate retry
    // that is denied again.
    const decision = consume("alice", 1_000_000 + 59_500);

    assert.equal(decision.allowed, false);
    assert.equal(decision.retryAfterSeconds, 1);
  });

  it("lets the user through again once the window has passed", () => {
    assert.equal(consume("alice", 1_000_000 + 60_001).allowed, true);
  });

  it("forgets a user who stopped asking", () => {
    // The map must not grow one permanent entry per user who ever signed in.
    consume("carol", 2_000_000);
    consume("dave", 2_000_000 + 60_001);

    // carol's window is gone, so she starts from zero rather than from three.
    for (let i = 0; i < 3; i++) {
      assert.equal(consume("carol", 2_000_000 + 60_001).allowed, true);
    }
  });
});
