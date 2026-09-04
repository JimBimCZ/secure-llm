import type {
  AnswerInput,
  AnswerResult,
  AnswerStreamEvent,
  LlmProvider,
} from "@/server/ai/types";
import { env } from "@/server/env";
import { recordLlmCall } from "@/server/log/llmAudit";
import { logger } from "@/server/log/logger";

/**
 * The one door out of the process.
 *
 * CLAUDE.md §5 asks that every call leaving the app go through a single wrapper
 * that enforces a timeout and writes the audit record. Both live here so
 * neither can be forgotten at a call site: `rag/answer.ts` cannot reach a
 * provider without passing through this function.
 *
 * What the audit record contains is as important as what it contains: model,
 * timestamp, token counts, latency, outcome — and NEVER the question, the
 * answer, the citations, or any document text (§3). Everything in the object
 * below is a number, an identifier or a timestamp; nothing is content. A
 * failure is audited too, with the error's type but not its message, since a
 * provider error can quote the request back at you.
 *
 * The record is written twice, on purpose: to the `llm_calls` table, which the
 * retention job purges after RETENTION_AUDIT_DAYS, and to the structured log,
 * which the operator's collector retains on its own schedule. The table is the
 * queryable one; the log line is what survives if the database is the thing
 * that broke.
 */
export async function answerWithAudit(
  provider: LlmProvider,
  input: AnswerInput,
): Promise<AnswerResult> {
  const startedAt = Date.now();
  // Cancels the underlying request rather than merely abandoning it: a call we
  // stopped waiting for keeps running, and keeps costing, until it is aborted.
  const signal = AbortSignal.timeout(env.LLM_TIMEOUT_MS);

  try {
    const result = await provider.answer(input, signal);

    await recordLlmCall({
      provider: provider.name,
      model: provider.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      latencyMs: Date.now() - startedAt,
      outcome: "ok",
    });

    logger.info(
      {
        audit: "llm_call",
        provider: provider.name,
        model: provider.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        latencyMs: Date.now() - startedAt,
        outcome: "ok",
      },
      "llm call",
    );

    return result;
  } catch (error) {
    const outcome = signal.aborted ? "timeout" : "error";

    await recordLlmCall({
      provider: provider.name,
      model: provider.model,
      // Unknown: the call never returned usage. Recorded as zero rather than
      // omitted, so a failed call still counts as a call that was made.
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - startedAt,
      outcome,
    });

    logger.warn(
      {
        audit: "llm_call",
        provider: provider.name,
        model: provider.model,
        latencyMs: Date.now() - startedAt,
        outcome,
        // The name of the error class, not its message: a provider error can
        // echo the request, and the request contains the user's own notes.
        errorType: error instanceof Error ? error.name : "unknown",
      },
      "llm call failed",
    );

    throw error;
  }
}

/**
 * The same door out, for a call that arrives in pieces.
 *
 * It exists so that streaming does not become a way around the wrapper
 * CLAUDE.md §5 asks for: the audit row and the timeout live here for a
 * streaming call exactly as they do for a whole one. What differs is when the
 * numbers are known — usage arrives with the last event, not the returned
 * promise, and latency is measured to the last token rather than to a return.
 *
 * The audit write sits in a `finally`, not after the loop, and that is not a
 * style choice. `askQuestionStream` in rag/answer.ts `break`s out of this
 * generator the moment the citation guard rejects an answer — and a `break`
 * sends the generator a return completion, which skips any code written after
 * the loop and never reaches a `catch` either. Code placed after the loop, as
 * a first draft of this function had it, would leave a rejected call with NO
 * audit row at all, which §3 does not allow. A `finally` runs on all three
 * exits from the block below — the loop finishing on its own, the consumer
 * abandoning it early, and the loop throwing — so exactly one record is
 * written every time, carrying whatever `usage` and `firstTokenMs` had arrived
 * by the moment the call stopped.
 */
export async function* answerStreamWithAudit(
  provider: LlmProvider,
  input: AnswerInput,
): AsyncGenerator<AnswerStreamEvent> {
  const startedAt = Date.now();
  // Cancels the underlying request rather than merely abandoning it: a call we
  // stopped waiting for keeps running, and keeps costing, until it is aborted.
  const signal = AbortSignal.timeout(env.LLM_TIMEOUT_MS);

  let firstTokenMs: number | undefined;
  let usage = { inputTokens: 0, outputTokens: 0 };
  // "ok" unless the catch below says otherwise. This is also the outcome
  // recorded when the CONSUMER stops early — an abandoned stream is not a
  // failure of the call, it is the caller choosing not to want the rest of it.
  let outcome: "ok" | "timeout" | "error" = "ok";
  // Only set on the thrown-error path; kept out of the audit record itself
  // (§3: no content) and used only for the structured log line, same as the
  // whole-answer wrapper above.
  let errorType: string | undefined;

  try {
    // Falls back to the whole-answer call when the provider cannot stream, so
    // this wrapper is the one door regardless of which providers can.
    const stream = provider.answerStream
      ? provider.answerStream(input, signal)
      : oneShotFromAnswer(provider, input, signal);

    for await (const event of stream) {
      if (event.type === "delta" && firstTokenMs === undefined) {
        firstTokenMs = Date.now() - startedAt;
      }
      if (event.type === "usage") {
        usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
      }
      yield event;
    }
  } catch (error) {
    outcome = signal.aborted ? "timeout" : "error";
    // The name of the error class, not its message: a provider error can echo
    // the request, and the request contains the user's own notes.
    errorType = error instanceof Error ? error.name : "unknown";
    throw error;
  } finally {
    const latencyMs = Date.now() - startedAt;

    await recordLlmCall({
      provider: provider.name,
      model: provider.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      latencyMs,
      firstTokenMs,
      outcome,
    });

    if (outcome === "ok") {
      logger.info(
        {
          audit: "llm_call",
          provider: provider.name,
          model: provider.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          latencyMs,
          firstTokenMs,
          outcome,
        },
        "llm call",
      );
    } else {
      logger.warn(
        {
          audit: "llm_call",
          provider: provider.name,
          model: provider.model,
          latencyMs,
          firstTokenMs,
          outcome,
          errorType,
        },
        "llm call failed",
      );
    }
  }
}

/**
 * A provider without `answerStream`, shaped like one that has it.
 *
 * NOT a duplicate of `oneShot` in rag/answer.ts, though it emits the same three
 * events: that one adapts an injected DEPENDENCY, so a test can drive the
 * orchestrator with a whole-answer stub and no provider at all, while this one
 * adapts a PROVIDER, so `anthropic` and `gateway` reach the audit wrapper
 * unchanged. They sit on opposite sides of the seam; neither can serve the
 * other's caller.
 */
async function* oneShotFromAnswer(
  provider: LlmProvider,
  input: AnswerInput,
  signal: AbortSignal,
): AsyncGenerator<AnswerStreamEvent> {
  const result = await provider.answer(input, signal);
  // Usage first, unlike a real streaming provider: this adapter wraps an
  // already-settled `AnswerResult`, so all three numbers are already final
  // before the first yield. Yielding usage last, as a real stream must, would
  // mean an early `break` by the consumer — see the citation guard above —
  // loses it, exactly the failure this function's sibling wrapper exists to
  // avoid.
  yield {
    type: "usage",
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  };
  yield { type: "citations", citations: result.citations };
  yield { type: "delta", text: result.answer };
}
