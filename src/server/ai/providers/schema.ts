import { z } from "zod";

/**
 * The shape the model must return. Shared by every provider that speaks the
 * Anthropic wire format; the mock constructs its result directly.
 *
 * At the vendor, the API is asked to enforce this server-side (structured
 * outputs). Through a gateway it is not, because a proxy is under no obligation
 * to implement a recent addition to the API it fronts — there the prompt states
 * the contract and the JSON is parsed out of the response text. Either way this
 * schema validates what arrives, which is the part that must not be optional:
 * a malformed response has to fail as a rejected answer, never as an undefined
 * field read three files away.
 */
export const answerSchema = z.object({
  /**
   * `citations` is declared FIRST, and that order is not cosmetic: it is the
   * order the prompt asks the model for and the order `structuredOutputs`
   * advertises to a server that enforces the schema. The streaming path can then
   * run the citation guard before any prose is shown. A model that ignores the
   * order still parses correctly — it just cannot be streamed early.
   *
   * Source numbers as shown in the prompt, 1-based. Whether they are in range
   * is the citation guard's decision, not this schema's — see rag/answer.ts.
   */
  citations: z.array(z.number().int()),
  answer: z.string(),
});

export type AnswerJson = z.infer<typeof answerSchema>;
