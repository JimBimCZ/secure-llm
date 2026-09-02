import type { AnswerInput, AnswerResult, LlmProvider } from "@/server/ai/types";
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
