import { redirect } from "next/navigation";

import { auth } from "@/server/auth/config";
import { env } from "@/server/env";

import { AskForm } from "./ask-form";

export const dynamic = "force-dynamic";

export default async function AskPage() {
  const session = await auth();
  if (!session?.sub) redirect("/");

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold">Ask your notes</h1>

      <p className="mt-2 text-sm text-slate-600">
        Answers come only from your own documents, and every answer links to the
        passage it came from. If nothing in your notes covers the question, the
        app says so rather than guessing.
      </p>

      <AskForm />

      {/* Naming the provider in the UI is not decoration: with no API key the
          app answers by extracting sentences, and anyone using it should be able
          to tell which mode they are looking at without reading the logs. */}
      <p className="mt-10 text-xs text-slate-400">
        Answering: {env.LLM_PROVIDER}
        {env.LLM_PROVIDER === "mock"
          ? " (extractive, no API key needed)"
          : ` · ${env.LLM_MODEL}`}{" "}
        · Embeddings: {env.EMBEDDING_PROVIDER}
      </p>
    </main>
  );
}
