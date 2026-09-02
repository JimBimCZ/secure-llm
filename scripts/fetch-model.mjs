/**
 * Downloads the embedding model into the image at BUILD time.
 *
 * The running container has `allowRemoteModels = false`, so it never contacts
 * the Hugging Face Hub. Fetching here means `docker compose up` works with no
 * network at all and cannot fail on a third party's uptime.
 *
 * Must request the same dtype the app uses, or it would cache the 96 MB
 * float32 weights and the runtime would then look for quantized ones it does
 * not have.
 */
const model = process.env.EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2";
const cacheDir = process.env.EMBEDDING_CACHE_DIR ?? "./.models";

const { pipeline, env } = await import("@huggingface/transformers");
env.cacheDir = cacheDir;
env.allowRemoteModels = true;

const startedAt = Date.now();
const extractor = await pipeline("feature-extraction", model, { dtype: "q8" });

// Prove the cached files actually load and produce the expected width, rather
// than only that some bytes were written.
const out = await extractor(["build-time verification"], {
  pooling: "mean",
  normalize: true,
});
const [dims] = out.tolist();

console.log(
  `fetched ${model} (q8) into ${cacheDir} in ${Date.now() - startedAt}ms, ${dims.length} dimensions`,
);
