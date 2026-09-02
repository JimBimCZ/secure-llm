"use client";

import Link from "next/link";
import { useState } from "react";

interface Citation {
  chunkId: string;
  documentId: string;
  filename: string;
  chunkIndex: number;
  content: string;
}

interface Privacy {
  redactedQuestion: string;
  replaced: { persons: number; emails: number; phones: number };
}

type AskResult =
  | {
      status: "answered";
      answer: string;
      citations: Citation[];
      privacy: Privacy;
    }
  | { status: "not_found"; reason: string };

/**
 * The whole product in one form: a question, an answer, and the sources it came
 * from. Plain on purpose — visual design is not what this project is about, and
 * the thing worth looking at here is that every answer is followed by links, or by an
 * admission that there was nothing to link to.
 */
export function AskForm() {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskResult | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask(event: React.FormEvent) {
    event.preventDefault();
    if (question.trim().length < 3) return;

    setPending(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload.error ?? "Something went wrong. Try again.");
        return;
      }

      setResult(await response.json());
    } catch {
      setError("Could not reach the server.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-8">
      <form onSubmit={ask} className="flex gap-2">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="What did I write about NVMe drive endurance?"
          disabled={pending}
          className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={pending || question.trim().length < 3}
          className="cursor-pointer rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? "Searching…" : "Ask"}
        </button>
      </form>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {result?.status === "not_found" && (
        <div className="mt-6 rounded border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">
            Not found in your knowledge base.
          </p>
          <p className="mt-1 text-xs text-amber-800">
            {result.reason === "no_relevant_chunks"
              ? "Nothing in your documents was close enough to the question to answer it."
              : "An answer came back, but it could not be traced to a source, so it was discarded."}
          </p>
        </div>
      )}

      {result?.status === "answered" && (
        <div className="mt-6">
          <p className="whitespace-pre-wrap text-slate-900">{result.answer}</p>

          <PrivacyPanel privacy={result.privacy} />

          <h2 className="mt-6 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Sources
          </h2>
          <ol className="mt-2 space-y-2">
            {result.citations.map((citation, i) => (
              <li key={citation.chunkId} className="text-sm">
                <Link
                  href={`/documents/${citation.documentId}?cite=${citation.chunkIndex}`}
                  className="font-medium underline"
                >
                  [{i + 1}] {citation.filename}
                </Link>
                <p className="mt-1 line-clamp-3 text-xs text-slate-500">
                  {citation.content.slice(0, 240)}…
                </p>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

/**
 * Makes the anonymizer visible, which CLAUDE.md §3 requires rather than
 * merely permits.
 *
 * It shows the question exactly as it left the process. The answer above it
 * has already had the placeholders replaced, so the two together demonstrate
 * both directions of the round trip on screen: personal data out, personal
 * data back in. Showing the user their own values is not a leak — they own the
 * documents — but the mapping itself is never sent here, only the counts.
 */
function PrivacyPanel({ privacy }: { privacy: Privacy }) {
  const { persons, emails, phones } = privacy.replaced;
  const total = persons + emails + phones;

  return (
    <details className="mt-4 rounded border border-slate-200 bg-slate-50 p-3">
      <summary className="cursor-pointer text-xs text-slate-600">
        {total === 0
          ? "Nothing personal was found to redact"
          : `${total} value${total === 1 ? "" : "s"} redacted before this left the app`}
      </summary>

      <p className="mt-3 text-xs font-medium text-slate-500">
        The question as it was sent to the model
      </p>
      <p className="mt-1 font-mono text-xs text-slate-800">
        {privacy.redactedQuestion}
      </p>

      {total > 0 && (
        <p className="mt-3 text-xs text-slate-500">
          Replaced across the question and the retrieved passages: {persons}{" "}
          name{persons === 1 ? "" : "s"}, {emails} e-mail
          {emails === 1 ? "" : "s"}, {phones} phone number
          {phones === 1 ? "" : "s"}. The mapping back exists only for the life of
          the request and is never stored or logged.
        </p>
      )}
    </details>
  );
}
