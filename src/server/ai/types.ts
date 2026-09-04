/**
 * The two seams. Nothing outside src/server/ai/ knows which implementation is
 * in use, and nothing outside the provider files knows about HTTP, headers or
 * vendor JSON. See CLAUDE.md §5.
 */

export interface AnswerInput {
  question: string;
  /** Shown to the model as numbered sources [1]…[n], in exactly this order. */
  chunks: { id: string; documentId: string; content: string }[];
  /**
   * Set on the one retry the citation guard is allowed. Providers swap in the
   * stricter prompt; nothing else about the call changes.
   */
  retry?: boolean;
}

export interface AnswerResult {
  answer: string;
  /**
   * 1-based positions in `AnswerInput.chunks` — NOT ids.
   *
   * The model never sees a chunk id, so it cannot invent one that happens to
   * exist. A citation is either a position in the set we retrieved or it is out
   * of range, and the guard in rag/answer.ts decides which. Returned exactly as
   * the model gave it: a provider that quietly dropped bad numbers would hide
   * the very failure the guard exists to catch.
   */
  citations: number[];
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * One event from a provider that can answer incrementally.
 *
 * `citations` comes FIRST, which is the whole point: the guard in
 * rag/answer.ts can then run before a word of prose is shown, so an answer
 * that cites nothing valid is refused without the user having read it. The
 * prompt asks the model for that field order and `ai/partialJson.ts` reads it
 * out of the response as it arrives.
 *
 * `usage` arrives last, because token counts are only final when the call is.
 */
export type AnswerStreamEvent =
  | { type: "citations"; citations: number[] }
  | { type: "delta"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number };

/**
 * A streamed answer the finished reply cannot vouch for.
 *
 * Thrown only by a provider that has ALREADY emitted prose and then discovers,
 * from the complete message, that the prose was not the model's answer — the
 * reply does not parse, or it parses to different citations or different text
 * than what went out. It is a failed call either way; the type exists because
 * the two ways of failing after emitting need opposite treatment downstream.
 *
 * A truncation (`stop_reason: max_tokens`) and a dropped connection are NOT
 * this: there, what streamed is genuine as far as it got, and the orchestrator
 * keeps it on screen marked incomplete. Here nothing that went out is vouched
 * for, so `rag/answer.ts` retracts it — CLAUDE.md §6 is a promise about what
 * the user is left looking at, not only about what was validated.
 */
export class UnverifiedAnswerError extends Error {
  // Set explicitly: the route logs `error.name` and nothing else, and a
  // subclass inherits "Error" there unless it is named.
  override readonly name = "UnverifiedAnswerError";
}

export interface LlmProvider {
  readonly name: string;
  /**
   * What actually produced the answer, recorded on every audit record.
   *
   * The mock answers no model at all, so logging `LLM_MODEL` regardless would
   * put a model id on a call that never made one — an audit trail that lies
   * about the least interesting case is not one you can cite for the
   * interesting ones. Mirrors `EmbeddingProvider.model` for the same reason.
   */
  readonly model: string;
  /**
   * `signal` is the timeout the call wrapper owns (see ai/call.ts). It is a
   * second argument rather than a field on the input because it says how to
   * make the call, not what to ask — and because a call that is merely raced
   * against a timer keeps running, and keeps costing, after we stop waiting.
   */
  answer(input: AnswerInput, signal: AbortSignal): Promise<AnswerResult>;
  /**
   * Optional, and absence is not a defect: a provider without this is called
   * through `answer` and its whole reply is emitted as one delta, so nothing
   * above `providers/` has a second code path. Implemented where it has been
   * exercised against a live service — see README gaps 1 and 2 for why that
   * excludes the vendor and the gateway stub.
   */
  answerStream?(
    input: AnswerInput,
    signal: AbortSignal,
  ): AsyncIterable<AnswerStreamEvent>;
}

export interface EmbeddingProvider {
  readonly name: string;
  /** Recorded on every chunk: vectors from different models are not comparable. */
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

/** Every stored vector has this width. Changing it is a migration, not a config change. */
export const EMBEDDING_DIMENSIONS = 384;
