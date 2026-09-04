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

/**
 * One line per NDJSON event from `POST /api/ask` (see `src/server/rag/answer.ts`).
 * `citations` always arrives before the first `delta` — the server only sends
 * it once the citation guard has accepted the sources and there is prose to
 * show. The state below is built to make that guarantee impossible to violate
 * from this side: `answer` text only ever renders once `citations` is non-null.
 */
type AskEvent =
  | { type: "privacy"; privacy: Privacy }
  | { type: "citations"; citations: Citation[] }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "not_found"; reason: string }
  | { type: "budget_exhausted"; scope: "user" | "deployment"; retryAfterSeconds: number }
  | { type: "error" };

type Outcome = "done" | "not_found" | "budget_exhausted" | "error";

/** Same wording the HTTP 429 path shows for each scope; see api/ask/route.ts. */
const LIMIT_MESSAGE: Record<"user" | "deployment", string> = {
  user: "You have reached today's question limit.",
  deployment: "This deployment has reached today's question limit.",
};

/**
 * The whole product in one form: a question, an answer, and the sources it came
 * from. Plain on purpose — visual design is not what this project is about, and
 * the thing worth looking at here is that every answer is followed by links, or by an
 * admission that there was nothing to link to.
 *
 * The answer now streams: sources first, then prose growing beneath them. Four
 * states, driven by the events read off the response body:
 *   1. asking          — request in flight, nothing back yet.
 *   2. checking sources — request in flight, no `citations` event yet. The
 *      state a rejected answer never leaves.
 *   3. answering        — citations rendered, answer text accumulating below.
 *   4. terminal         — `done`, or one of the refusals.
 */
export function AskForm() {
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [privacy, setPrivacy] = useState<Privacy | null>(null);
  const [citations, setCitations] = useState<Citation[] | null>(null);
  const [answer, setAnswer] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [notFoundReason, setNotFoundReason] = useState<string | null>(null);
  const [budgetScope, setBudgetScope] = useState<"user" | "deployment" | null>(
    null,
  );

  function handle(event: AskEvent) {
    switch (event.type) {
      case "privacy":
        setPrivacy(event.privacy);
        break;
      case "citations":
        setCitations(event.citations);
        break;
      case "delta":
        setAnswer((prev) => prev + event.text);
        break;
      case "done":
        setOutcome("done");
        break;
      case "not_found":
        setNotFoundReason(event.reason);
        setOutcome("not_found");
        break;
      case "budget_exhausted":
        setBudgetScope(event.scope);
        setOutcome("budget_exhausted");
        break;
      case "error":
        setOutcome("error");
        break;
    }
  }

  async function ask(event: React.FormEvent) {
    event.preventDefault();
    if (question.trim().length < 3) return;

    setPending(true);
    setError(null);
    setPrivacy(null);
    setCitations(null);
    setAnswer("");
    setOutcome(null);
    setNotFoundReason(null);
    setBudgetScope(null);

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

      // NDJSON: one JSON object per line. Read raw bytes rather than using
      // response.json() because this is a stream, not one blob — the whole
      // point of the slice is that sources land before the answer finishes.
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        // `stream: true` holds back an incomplete multibyte character at the
        // end of this chunk instead of decoding it to U+FFFD, so a character
        // split across two reads comes out correct once its bytes are
        // complete.
        buffer += decoder.decode(value, { stream: true });

        // A chunk can also split a *line* anywhere, independent of the byte
        // splitting above, so the last (possibly partial) piece is kept in
        // the buffer until its newline arrives.
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.trim().length === 0) continue;
          handle(JSON.parse(line) as AskEvent);
        }
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setPending(false);
    }
  }

  // "Checking sources…" is the state a rejected answer never leaves: the
  // request is in flight and no `citations` event has arrived yet, so there
  // is nothing to show but the fact that the search is still happening.
  const checkingSources = pending && citations === null && answer === "";

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

      {checkingSources && (
        <p className="mt-4 text-sm text-slate-500">Checking your sources…</p>
      )}

      {outcome === "not_found" && (
        <div className="mt-6 rounded border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">
            Not found in your knowledge base.
          </p>
          <p className="mt-1 text-xs text-amber-800">
            {notFoundReason === "no_relevant_chunks"
              ? "Nothing in your documents was close enough to the question to answer it."
              : "An answer came back, but it could not be traced to a source, so it was discarded."}
          </p>
        </div>
      )}

      {outcome === "budget_exhausted" && budgetScope && (
        <p className="mt-4 text-sm text-red-600">
          {LIMIT_MESSAGE[budgetScope]}
        </p>
      )}

      {outcome === "error" && citations === null && (
        <p className="mt-4 text-sm text-red-600">
          Something went wrong. Try again.
        </p>
      )}

      {citations !== null && (
        <div className="mt-6">
          <p className="whitespace-pre-wrap text-slate-900">{answer}</p>

          {outcome === "error" && (
            <p className="mt-2 text-sm text-red-600">
              The connection dropped before the answer finished.
            </p>
          )}

          {privacy && <PrivacyPanel privacy={privacy} />}

          <h2 className="mt-6 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Sources
          </h2>
          <ol className="mt-2 space-y-2">
            {citations.map((citation, i) => (
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
