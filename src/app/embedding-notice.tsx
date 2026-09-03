import { getEmbeddingStatus } from "@/server/rag/embeddingStatus";

import { ReembedButton } from "./reembed-button";

/**
 * The app saying out loud that it cannot see some of your documents.
 *
 * Retrieval filters on the model that produced each vector, so changing the
 * embedder does not degrade search — it empties it, silently, while the
 * documents page goes on counting chunks that no question can reach. Without
 * this banner the only symptom is "Not found in your knowledge base." on a
 * corpus that plainly covers the question, which is the app lying by omission.
 *
 * Renders nothing at all in the normal case. A notice that appears when there
 * is nothing to say trains people to ignore it.
 */
export async function EmbeddingNotice({ ownerSub }: { ownerSub: string }) {
  const status = await getEmbeddingStatus(ownerSub);
  if (status.stale.length === 0) return null;

  return (
    <div className="mt-6 rounded border border-amber-300 bg-amber-50 p-4">
      <p className="text-sm font-medium text-amber-900">
        {status.currentChunks === 0
          ? "None of your documents can be searched right now."
          : "Some of your documents cannot be searched right now."}
      </p>

      <ul className="mt-2 space-y-1 text-xs text-amber-900">
        {status.stale.map((row) => (
          <li key={row.model}>
            {row.chunks} chunk{row.chunks === 1 ? "" : "s"} in {row.documents}{" "}
            document{row.documents === 1 ? "" : "s"} indexed with{" "}
            <code>{row.model}</code>
          </li>
        ))}
      </ul>

      <p className="mt-2 text-xs text-amber-900">
        Retrieval now uses <code>{status.activeModel}</code>. Vectors from two
        models are not comparable, so those documents are invisible to search
        until they are embedded again — they are not lost, and they are still
        readable and deletable here. Re-embedding reads each document&rsquo;s
        stored text, splits it for the current model and indexes it again; it
        does not re-read the original file.
      </p>

      <ReembedButton />
    </div>
  );
}
