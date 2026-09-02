import { db } from "@/server/db";
import { llmCalls } from "@/server/db/schema";
import { logger } from "@/server/log/logger";

export interface LlmAuditRecord {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  outcome: "ok" | "timeout" | "error";
}

/**
 * Writes one audit row per call that left the process (CLAUDE.md §3).
 *
 * Every field is a number, an identifier or an outcome. There is no parameter
 * here that could carry a prompt, an answer or document text — the type is the
 * control, not a convention someone has to remember.
 *
 * A failure to audit must never fail the user's question: the answer is
 * already computed and correct, and losing one cost record is a smaller harm
 * than a 500. It is logged at error so the loss is visible rather than silent.
 */
export async function recordLlmCall(record: LlmAuditRecord): Promise<void> {
  try {
    await db.insert(llmCalls).values(record);
  } catch (error) {
    logger.error({ err: error }, "failed to write llm audit record");
  }
}
