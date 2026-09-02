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
  answer: z.string(),
  /**
   * Source numbers as shown in the prompt, 1-based. Whether they are in range
   * is the citation guard's decision, not this schema's — see rag/answer.ts.
   */
  citations: z.array(z.number().int()),
});

export type AnswerJson = z.infer<typeof answerSchema>;
