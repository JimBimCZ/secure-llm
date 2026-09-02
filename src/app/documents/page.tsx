import { desc, eq, sql } from "drizzle-orm";
import { redirect } from "next/navigation";

import { auth } from "@/server/auth/config";
import { db } from "@/server/db";
import { chunks, documents } from "@/server/db/schema";

import { DocumentActions } from "./actions";

export const dynamic = "force-dynamic";

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} kB`;
}

export default async function DocumentsPage() {
  const session = await auth();
  if (!session?.sub) redirect("/");

  const rows = await db
    .select({
      id: documents.id,
      filename: documents.filename,
      byteSize: documents.byteSize,
      createdAt: documents.createdAt,
      chunkCount: sql<number>`count(${chunks.id})::int`,
    })
    .from(documents)
    .leftJoin(chunks, eq(chunks.documentId, documents.id))
    .where(eq(documents.ownerSub, session.sub))
    .groupBy(documents.id)
    .orderBy(desc(documents.createdAt));

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold">Your documents</h1>

      <p className="mt-2 text-sm text-slate-600">
        {rows.length} document{rows.length === 1 ? "" : "s"}, indexed as{" "}
        {rows.reduce((sum, r) => sum + r.chunkCount, 0)} chunks. Accepted
        formats: .md, .txt, .pdf.
      </p>

      <DocumentActions />

      <ul className="mt-8 divide-y divide-slate-200 border-t border-slate-200">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center gap-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{row.filename}</p>
              <p className="text-xs text-slate-500">
                {formatSize(row.byteSize)} · {row.chunkCount} chunks ·{" "}
                {row.createdAt.toISOString().slice(0, 10)}
              </p>
            </div>
            <DocumentActions documentId={row.id} filename={row.filename} />
          </li>
        ))}
      </ul>

      {rows.length === 0 && (
        <p className="mt-8 text-sm text-slate-500">
          Nothing here yet. Upload a file above.
        </p>
      )}
    </main>
  );
}
