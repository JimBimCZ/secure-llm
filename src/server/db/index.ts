import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { env } from "@/server/env";

/**
 * Next.js reloads modules in development, which would otherwise open a new pool
 * on every edit until Postgres refuses connections. Cache it on globalThis.
 */
const globalForDb = globalThis as unknown as { pool?: Pool };

export const pool =
  globalForDb.pool ??
  new Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 5_000,
  });

if (env.NODE_ENV !== "production") {
  globalForDb.pool = pool;
}

export const db = drizzle(pool);
