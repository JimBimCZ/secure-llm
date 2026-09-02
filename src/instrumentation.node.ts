import { runMigrations } from "@/server/db/migrate";
import { logger } from "@/server/log/logger";
import { startRetentionSchedule } from "@/server/retention/purge";

logger.info(
  { nodeVersion: process.version, nodeEnv: process.env.NODE_ENV },
  "application starting",
);

try {
  await runMigrations();
} catch (error) {
  logger.error({ err: error }, "startup failed: could not apply migrations");
  throw error;
}

// Retention runs from startup, not from the first request: a deployment that
// is never asked a question must still forget on schedule (CLAUDE.md §7).
startRetentionSchedule();

logger.info("application started");
