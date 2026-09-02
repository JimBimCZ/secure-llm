"use client";

import { useState, useTransition } from "react";

/**
 * "Delete my account" (CLAUDE.md §7).
 *
 * Two-step on purpose: the first click arms it, the second does it. A single
 * confirm() next to a Sign out button is one misclick away from destroying
 * everything the user has, and this is the one irreversible action in the app.
 *
 * The server takes no parameter — the subject comes from the session — so this
 * button cannot be pointed at anyone else's data.
 */
export function DeleteAccount({ signOutAction }: { signOutAction: () => Promise<void> }) {
  const [armed, setArmed] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        className="mt-4 cursor-pointer text-xs text-slate-500 underline"
      >
        Delete my account and all my documents
      </button>
    );
  }

  return (
    <div className="mt-4 rounded border border-red-200 bg-red-50 p-3">
      <p className="text-xs text-red-900">
        This deletes every document, chunk and embedding belonging to you,
        immediately and permanently. It cannot be undone.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const response = await fetch("/api/me", { method: "DELETE" });
              if (!response.ok) {
                setError("Delete failed.");
                return;
              }
              await signOutAction();
            })
          }
          className="cursor-pointer rounded bg-red-700 px-3 py-1.5 text-xs text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Deleting…" : "Yes, delete everything"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => setArmed(false)}
          className="cursor-pointer rounded border border-slate-300 px-3 py-1.5 text-xs"
        >
          Cancel
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
    </div>
  );
}
