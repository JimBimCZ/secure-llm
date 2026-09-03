"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * Runs the rebuild and then re-renders the notice that offered it.
 *
 * When everything succeeds the notice disappears, which is the feedback. The
 * message below is what remains when it does not: a document that could not be
 * rebuilt is still stale, so the banner stays and has to say why it stayed.
 */
export function ReembedButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="mt-3">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setMessage(null);
            const response = await fetch("/api/documents/reembed", {
              method: "POST",
            });

            if (!response.ok) {
              setMessage("Re-embedding failed. Nothing was changed.");
              return;
            }

            const result = await response.json();
            setMessage(
              result.failed > 0
                ? `Rebuilt ${result.documents} document(s). ${result.failed} could not be rebuilt and are unchanged.`
                : `Rebuilt ${result.documents} document(s), ${result.chunks} chunks.`,
            );
            router.refresh();
          })
        }
        className="cursor-pointer rounded bg-slate-900 px-3 py-1.5 text-xs text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Re-embedding…" : "Re-embed these documents"}
      </button>
      {pending && (
        <p className="mt-2 text-xs text-slate-600">
          Reading each document again, splitting it for the current model and
          embedding it. This runs in the request; large corpora take a while.
        </p>
      )}
      {message && <p className="mt-2 text-xs text-slate-700">{message}</p>}
    </div>
  );
}
