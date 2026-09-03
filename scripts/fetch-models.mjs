/**
 * Downloads the models into the image at BUILD time.
 *
 * The running container has `allowRemoteModels = false`, so this is the only
 * chance to fetch them — and it means `docker compose up` works with no
 * network at all and cannot fail on a third party's uptime.
 *
 * Must request the same dtype the app uses, or it would cache the float32
 * weights and the runtime would then look for quantized ones it does not have.
 */
const cacheDir = process.env.MODEL_CACHE_DIR ?? "./.models";

const embeddingModel = process.env.EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2";
const anonymizerModel =
  process.env.ANONYMIZER_MODEL ?? "Xenova/distilbert-base-multilingual-cased-ner-hrl";

const { pipeline, env } = await import("@huggingface/transformers");
env.cacheDir = cacheDir;
env.allowRemoteModels = true;

// Prove the cached files actually load and produce what the app expects,
// rather than only that some bytes were written.

let startedAt = Date.now();
const extractor = await pipeline("feature-extraction", embeddingModel, { dtype: "q8" });
const [dims] = (
  await extractor(["build-time verification"], { pooling: "mean", normalize: true })
).tolist();
console.log(
  `fetched ${embeddingModel} (q8) into ${cacheDir} in ${Date.now() - startedAt}ms, ${dims.length} dimensions`,
);

startedAt = Date.now();
const tagger = await pipeline("token-classification", anonymizerModel, { dtype: "q8" });
const tagged = await tagger("Petra Horáková");
const people = tagged.filter((t) => t.entity.endsWith("PER")).length;
console.log(
  `fetched ${anonymizerModel} (q8) into ${cacheDir} in ${Date.now() - startedAt}ms, ${people} person tokens on the smoke input`,
);

if (people === 0) {
  throw new Error(`${anonymizerModel} loaded but tagged no person — wrong model or wrong dtype`);
}
