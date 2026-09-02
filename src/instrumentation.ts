/**
 * Next.js calls `register()` once per server instance, and waits for it to
 * finish before serving requests. That guarantee is why startup work lives
 * here: migrations are applied before the first request can arrive.
 *
 * This file is also compiled for the edge runtime, where pg, the filesystem
 * and most of `process` do not exist. Everything Node-specific therefore sits
 * behind a dynamic import so it never enters the edge bundle.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  await import("./instrumentation.node");
}
