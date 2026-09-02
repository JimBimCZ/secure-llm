import { z } from "zod";

import { authErrorResponse, requireUser } from "@/server/auth/guard";
import { askQuestion } from "@/server/rag/answer";

export const dynamic = "force-dynamic";

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

    const parsed = askSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json(
        { error: "Ask a question between 3 and 1000 characters." },
        { status: 400 },
      );
    }

    const result = await askQuestion(sub, parsed.data.question);
    return Response.json(result);
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
