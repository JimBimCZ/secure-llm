import path from "node:path";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { db } from "@/server/db";
import { logger } from "@/server/log/logger";

/**
 * Applied on startup, before the server accepts requests (see src/instrumentation.ts).
 * `docker compose up` must arrive at a migrated schema with no manual step.
 */
export async function runMigrations(): Promise<void> {
  const migrationsFolder = path.join(process.cwd(), "src/server/db/migrations");
  const startedAt = Date.now();

  await migrate(db, { migrationsFolder });

  logger.info(
    { durationMs: Date.now() - startedAt },
    "database migrations applied",
  );
}
