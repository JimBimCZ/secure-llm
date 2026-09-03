import { runMigrations } from "@/server/db/migrate";
import { env } from "@/server/env";
import { logger } from "@/server/log/logger";
import { getPersonDetector } from "@/server/privacy/detectors";
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

// Loaded here rather than on the first question. Both timings fail closed — a
// detector that cannot load throws, and a throwing `redact` means no text
// leaves the process — so this prevents no leak. What it changes is who finds
// out: the healthcheck, or a user.
try {
  await getPersonDetector().warmUp();
} catch (error) {
  logger.error(
    // The effective value, not `process.env` — the variable is defaulted by
    // zod, so the raw environment reads undefined in the common case and would
    // name nothing at the one moment an operator needs it named.
    { err: error, provider: env.ANONYMIZER_PROVIDER },
    "startup failed: could not load the person detector",
  );
  throw error;
}

// Retention runs from startup, not from the first request: a deployment that
// is never asked a question must still forget on schedule (CLAUDE.md §7).
startRetentionSchedule();

logger.info("application started");
