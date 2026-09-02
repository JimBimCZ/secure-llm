import pino from "pino";

import { env } from "@/server/env";

/**
 * One logger for the whole process. Structured JSON to stdout — the operator's
 * log collector is responsible for shipping and retaining it (see the retention
 * table in the README).
 *
 * Nothing here may log document text, prompts, answers, or the anonymisation
 * mapping. See CLAUDE.md §3 and §7.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "pkb" },
  redact: {
    paths: [
      "password",
      "*.password",
      "token",
      "*.token",
      "authorization",
      "*.authorization",
      "apiKey",
      "*.apiKey",
    ],
    remove: true,
  },
});
