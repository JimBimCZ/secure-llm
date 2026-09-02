import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { count, eq } from "drizzle-orm";

import { db } from "@/server/db";
import { documents } from "@/server/db/schema";
import { logger } from "@/server/log/logger";
import { ACCEPTED_EXTENSIONS } from "@/server/rag/extract";
import { ingestDocument } from "@/server/rag/ingest";

const SEED_DIR = path.join(process.cwd(), "seed");

const MEDIA_TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".pdf": "application/pdf",
};

/**
 * Gives a brand-new user the synthetic corpus so there is something to
 * search the moment they sign in — the "seed data loaded" half of the
 * zero-manual-steps requirement (CLAUDE.md §3).
 *
 * Runs on first sign-in rather than at startup because documents belong to a
 * subject, and no subject exists until someone signs in. It is cheap: ~40
 * chunks embed in well under a second.
 *
 * Idempotent by construction — a user who already has documents is skipped, so
 * signing in twice does not duplicate the corpus.
 */
export async function seedUserIfEmpty(ownerSub: string): Promise<void> {
  const [existing] = await db
    .select({ total: count() })
    .from(documents)
    .where(eq(documents.ownerSub, ownerSub));

  if ((existing?.total ?? 0) > 0) return;

  const startedAt = Date.now();
  let loaded = 0;

  try {
    const entries = await readdir(SEED_DIR, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((name) =>
        (ACCEPTED_EXTENSIONS as readonly string[]).includes(
          path.extname(name).toLowerCase(),
        ),
      )
      .sort();

    for (const filename of files) {
      const bytes = await readFile(path.join(SEED_DIR, filename));
      await ingestDocument({
        ownerSub,
        filename,
        mediaType: MEDIA_TYPES[path.extname(filename).toLowerCase()] ?? "application/octet-stream",
        bytes: new Uint8Array(bytes),
      });
      loaded += 1;
    }
  } catch (error) {
    // A missing or unreadable seed folder must not block sign-in — the user
    // simply starts with an empty knowledge base.
    logger.error({ err: error, sub: ownerSub, loaded }, "seeding failed");
    return;
  }

  logger.info(
    { sub: ownerSub, documents: loaded, durationMs: Date.now() - startedAt },
    "seed corpus loaded for new user",
  );
}
