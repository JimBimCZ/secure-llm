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
