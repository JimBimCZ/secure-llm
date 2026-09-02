import type { FeatureExtractionPipeline } from "@huggingface/transformers";

import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from "@/server/ai/types";
import { env } from "@/server/env";
import { logger } from "@/server/log/logger";

/**
 * Embeddings computed in this process. No text leaves the app to be embedded —
 * only the answer step ever crosses a network boundary, and that text is
 * anonymised first (CLAUDE.md §5, §7).
 *
 * The model is baked into the image at build time and remote fetches are
 * disabled, so the container never contacts the Hugging Face Hub and
 * `docker compose up` works with no network at all.
 */
let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

async function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (pipelinePromise) return pipelinePromise;

  pipelinePromise = (async () => {
    const { pipeline, env: hfEnv } = await import("@huggingface/transformers");

    hfEnv.cacheDir = env.EMBEDDING_CACHE_DIR;
    hfEnv.localModelPath = env.EMBEDDING_CACHE_DIR;
    // If the model is missing, fail loudly at startup rather than silently
    // reaching out to the internet from a container that should not have any.
    hfEnv.allowRemoteModels = false;

    const startedAt = Date.now();
    const extractor = await pipeline("feature-extraction", env.EMBEDDING_MODEL, {
      // 8-bit weights: 23 MB in the image instead of 96 MB, same 384 dimensions,
      // and retrieval quality holds (see docs/decisions.md).
      dtype: "q8",
    });

    logger.info(
      { model: env.EMBEDDING_MODEL, loadMs: Date.now() - startedAt },
      "embedding model loaded",
    );
    return extractor;
  })();

  return pipelinePromise;
}

export function createLocalEmbedder(): EmbeddingProvider {
  return {
    name: "local",
    model: env.EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,

    async embed(texts) {
      if (texts.length === 0) return [];

      const extractor = await getPipeline();
      // mean pooling + normalise gives unit vectors, so cosine distance and
      // dot product agree and scores are comparable with the mock provider.
      const output = await extractor(texts, { pooling: "mean", normalize: true });
      const vectors = output.tolist() as number[][];

      const width = vectors[0]?.length ?? 0;
      if (width !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Embedding model returned ${width} dimensions, schema expects ${EMBEDDING_DIMENSIONS}`,
        );
      }

      return vectors;
    },
  };
}
