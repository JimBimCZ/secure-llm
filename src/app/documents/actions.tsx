"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * Upload and delete controls. Deliberately plain: visual design is not the point
 * here, and every one of these actions is authorised again on the server.
 */
export function DocumentActions({
  documentId,
  filename,
}: {
  documentId?: string;
  filename?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (documentId) {
    return (
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (!confirm(`Delete ${filename}? This cannot be undone.`)) return;
          startTransition(async () => {
            const response = await fetch(`/api/documents/${documentId}`, {
              method: "DELETE",
            });
            if (!response.ok) setError("Delete failed");
            router.refresh();
          });
        }}
        className="shrink-0 cursor-pointer rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Deleting…" : "Delete"}
      </button>
    );
  }

  return (
    <div className="mt-6">
      <input
        type="file"
        accept=".md,.txt,.pdf"
        disabled={pending}
        className="block w-full cursor-pointer text-sm file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-sm file:text-white"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          setError(null);

          const body = new FormData();
          body.append("file", file);

          startTransition(async () => {
            const response = await fetch("/api/documents", { method: "POST", body });
            if (!response.ok) {
              const payload = await response.json().catch(() => ({}));
              setError(payload.error ?? "Upload failed");
            }
            event.target.value = "";
            router.refresh();
          });
        }}
      />
      {pending && <p className="mt-2 text-xs text-slate-500">Indexing…</p>}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}
