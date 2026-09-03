import { env } from "@/server/env";

/**
 * The one place that configures `@huggingface/transformers` for this process.
 *
 * `cacheDir`, `localModelPath` and `allowRemoteModels` are PROCESS-GLOBAL in
 * that library, and two models now depend on them: the embedder (CLAUDE.md §5)
 * and the person detector (§7). Two callers setting them independently would
 * mean whichever loaded second silently reconfigured the first, which is the
 * kind of bug that only shows up as a model quietly loading from the wrong
 * place. So they are set here, once, and both loaders come through here.
 *
 * `allowRemoteModels = false` is the promise that the container never reaches
 * the Hugging Face Hub: every model is baked into the image at build time, so
 * `docker compose up` works with no network and cannot fail on a third party's
 * uptime. A missing model must fail loudly rather than be fetched.
 */
let configured: Promise<typeof import("@huggingface/transformers")> | null = null;

export function transformers(): Promise<typeof import("@huggingface/transformers")> {
  if (configured) return configured;

  configured = (async () => {
    const module = await import("@huggingface/transformers");

    module.env.cacheDir = env.MODEL_CACHE_DIR;
    module.env.localModelPath = env.MODEL_CACHE_DIR;
    module.env.allowRemoteModels = false;

    return module;
  })();

  return configured;
}
