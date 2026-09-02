import { and, asc, eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";

import { auth } from "@/server/auth/config";
import { db } from "@/server/db";
import { chunks, documents } from "@/server/db/schema";

import { ScrollToCitation } from "./scroll-to-citation";

export const dynamic = "force-dynamic";

/**
 * The other half of the citation promise: a link that lands on the passage.
 *
 * The document's original text is stored whole, and each chunk kept the
 * character offsets it was cut from, so the cited passage is located by slicing
 * the original rather than by re-running the chunker or by string-matching the
 * quote. Chunks overlap by design, which is exactly why only the one cited
 * range is highlighted — highlighting every chunk would paint most of the page.
 */
export default async function DocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cite?: string }>;
}) {
  const session = await auth();
  if (!session?.sub) redirect("/");

  const { id } = await params;
  const { cite } = await searchParams;

  // Ownership is part of the lookup, so another user's document is simply not
  // found — the page cannot reveal that the id exists.
  const [document] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), eq(documents.ownerSub, session.sub)))
    .limit(1);

  if (!document) notFound();

  const citedIndex = cite === undefined ? null : Number.parseInt(cite, 10);

  const [citedChunk] =
    citedIndex !== null && Number.isInteger(citedIndex)
      ? await db
          .select({
            startOffset: chunks.startOffset,
            endOffset: chunks.endOffset,
          })
          .from(chunks)
          .where(
            and(
              eq(chunks.documentId, document.id),
              eq(chunks.ownerSub, session.sub),
              eq(chunks.chunkIndex, citedIndex),
            ),
          )
          .orderBy(asc(chunks.chunkIndex))
          .limit(1)
      : [];

  const text = document.content;
  const before = citedChunk ? text.slice(0, citedChunk.startOffset) : text;
  const cited = citedChunk
    ? text.slice(citedChunk.startOffset, citedChunk.endOffset)
    : "";
  const after = citedChunk ? text.slice(citedChunk.endOffset) : "";

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <div className="flex items-baseline justify-between">
        <h1 className="truncate text-2xl font-semibold">{document.filename}</h1>
        <a className="shrink-0 text-sm text-slate-600 underline" href="/ask">
          Back to ask
        </a>
      </div>

      <p className="mt-2 text-sm text-slate-600">
        {citedChunk
          ? "The highlighted passage is the one the answer cited."
          : "Full document text as it was extracted and indexed."}
      </p>

      <article className="mt-8 whitespace-pre-wrap font-mono text-sm leading-6 text-slate-800">
        {before}
        {citedChunk && (
          <mark
            id="cited-passage"
            className="bg-amber-200 text-slate-900"
          >
            {cited}
          </mark>
        )}
        {after}
      </article>

      {citedChunk && <ScrollToCitation />}
    </main>
  );
}
