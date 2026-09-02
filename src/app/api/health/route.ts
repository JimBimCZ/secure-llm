import { NextResponse } from "next/server";

import { pool } from "@/server/db";
import { logger } from "@/server/log/logger";

// Health must reflect the state of this instant, never a cached response.
export const dynamic = "force-dynamic";

type DbHealth =
  | { status: "up"; latencyMs: number }
  | { status: "down"; error: string };

async function checkDatabase(): Promise<DbHealth> {
  const startedAt = Date.now();
  try {
    await pool.query("select 1");
    return { status: "up", latencyMs: Date.now() - startedAt };
  } catch (error) {
    logger.error({ err: error }, "health check: database unreachable");
    // Deliberately generic: a driver error can contain the connection string.
    return { status: "down", error: "database unreachable" };
  }
}

export async function GET() {
  const database = await checkDatabase();
  const healthy = database.status === "up";

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      uptimeSeconds: Math.round(process.uptime()),
      database,
    },
    { status: healthy ? 200 : 503 },
  );
}
