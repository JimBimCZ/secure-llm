import { z } from "zod";

import { authErrorResponse, requireUser } from "@/server/auth/guard";
import { logger } from "@/server/log/logger";
import { askQuestionStream } from "@/server/rag/answer";
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

    const encoder = new TextEncoder();

    /**
     * NDJSON: one event per line. Not SSE, which is shaped for GET and brings
     * reconnect semantics this endpoint must not have — a reconnect would mean
     * a second charged model call for a question already asked.
     *
     * The stream opens only once every refusal that can be decided up front has
     * been decided, so a status code still carries what a status code should.
     */
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        /**
         * A client that closes the tab mid-answer cancels this stream, and
         * every enqueue after that throws. That is an ordinary disconnect, not
         * a failure: there is nobody left to receive a terminal event and
         * nothing worth logging at error level. So writes are attempted
         * through one helper that notices the reader has gone, and the loop
         * stops pulling work nobody will read.
         */
        let open = true;

        const send = (event: unknown): void => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          } catch {
            open = false;
          }
        };

        try {
          for await (const event of askQuestionStream(sub, parsed.data.question)) {
            send(event);
            // The reader is gone. Abandoning the generator here also runs the
            // orchestrator's `finally`, so the call this user already reserved
            // is still charged.
            if (!open) break;
          }
        } catch (error) {
          // The connection is already open with a 200, so this cannot become a
          // status code. It becomes the terminal event the protocol defines
          // for exactly this.
          //
          // Only the error's CLASS is logged, never the error itself: pino
          // serializes an `err` key down to its message and stack, and a
          // provider error can quote the request back at us — a request built
          // from the user's own notes. src/server/ai/call.ts makes the same
          // choice for the same reason.
          logger.error(
            { errorType: error instanceof Error ? error.name : "unknown", sub },
            "ask stream failed",
          );
          send({ type: "error" });
        } finally {
          if (open) {
            try {
              controller.close();
            } catch {
              // Cancelled between the last write and here. Nothing to close.
            }
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        // Nothing here is cacheable and a proxy buffering it would undo the
        // whole feature.
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
