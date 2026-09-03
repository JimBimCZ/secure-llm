import { env } from "@/server/env";

/**
 * A per-user quota on the one endpoint that costs money.
 *
 * `/api/ask` is authenticated, so this is not a defence against the internet —
 * it is a bound on what one signed-in session can spend in a loop, whether the
 * loop is malicious, a retry storm, or a script someone left running. Without
 * it the only limit on the bill is how fast the model answers.
 *
 * A fixed window, counted in this process's memory. Two consequences, both
 * accepted deliberately and both written into the README:
 *
 * - It is per instance. Two replicas mean twice the limit. The right home for
 *   this control is the gateway that already sees every call and already holds
 *   the budget — which is one of the reasons corporate AI gateways exist. This
 *   is the honest in-app approximation, not a replacement for that.
 * - It resets on restart. For a spend ceiling that is the safe direction to be
 *   wrong in: a restart forgives a user, it never locks one out.
 *
 * A fixed window rather than a token bucket because the failure it prevents is
 * "a thousand questions in a minute", not "an uneven arrival pattern", and a
 * window is one number and one timestamp that anyone can read.
 */
const WINDOW_MS = 60_000;

interface Window {
  count: number;
  /** When this window ends and the count goes back to zero. */
  resetAt: number;
}

const windows = new Map<string, Window>();

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the caller may try again. Only meaningful when denied. */
  retryAfterSeconds: number;
}

/**
 * Counts one question against `sub`'s quota and says whether it may proceed.
 *
 * `now` is a parameter so the behaviour at a window boundary can be tested
 * without waiting a minute for it. Nothing in the application passes it.
 */
export function consumeAskQuota(sub: string, now = Date.now()): RateLimitDecision {
  const limit = env.ASK_RATE_LIMIT_PER_MINUTE;
  if (limit === 0) return { allowed: true, retryAfterSeconds: 0 };

  // Expired windows are dropped on the way past. At personal scale the map
  // holds one entry per user who asked something this minute, so this is
  // cheaper than owning a timer and never leaks a key for a user who left.
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }

  const window = windows.get(sub) ?? { count: 0, resetAt: now + WINDOW_MS };
  window.count += 1;
  windows.set(sub, window);

  if (window.count <= limit) return { allowed: true, retryAfterSeconds: 0 };

  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1_000)),
  };
}
