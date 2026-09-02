import { significantTerms } from "@/server/ai/lexical";
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from "@/server/ai/types";

/**
 * Deterministic embeddings with no model and no network — the hashing trick.
 *
 * Used by the unit tests and as the fallback when the model is unavailable
 * (notably: onnxruntime ships no darwin/x64 binary, so `npm run dev` outside
 * Docker on an Intel Mac cannot load the real one). It is NOT the demo path —
 * `local` is the default and needs no API key, so anyone running
 * `docker compose up` gets real semantic search.
 *
 * What it actually does, measured rather than assumed: it matches on shared
 * vocabulary. Against paraphrased questions over the seed corpus it returned
 * the right document for 2 of 3 probes, and it correctly ranked a question the
 * corpus cannot answer *below* the ones it can — which is the property the
 * citation guard depends on. It knows nothing about meaning: ask it something
 * using none of the document's words and it will not find it.
 *
 * Two details earn their place, both measured:
 * - Stopwords are dropped and term counts damped. Without this, common words
 *   dominated the buckets and an unanswerable question outranked answerable
 *   ones — exactly backwards.
 * - Unigrams only. Adding bigrams was tried and made every probe worse: 384
 *   buckets are too few, and the extra terms collide into noise.
 */

/** FNV-1a. Small, fast, and spreads tokens evenly across the buckets. */
function hash(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function embedOne(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);

  for (const [term, count] of significantTerms(text)) {
    const h = hash(term);
    // Sublinear damping: a term repeated ten times is not ten times the signal.
    const weight = 1 + Math.log(count);
    // Sign from a separate bit, so colliding terms can cancel rather than
    // always reinforcing one another.
    vector[h % EMBEDDING_DIMENSIONS] += ((h & 0x100) === 0 ? 1 : -1) * weight;
  }

  // Unit length, matching the real provider, so cosine distance behaves the
  // same and RAG_MIN_SCORE means something comparable in both modes.
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return norm === 0 ? vector : vector.map((v) => v / norm);
}

export function createMockEmbedder(): EmbeddingProvider {
  return {
    name: "mock",
    model: "mock-hashing-v1",
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(texts) {
      return texts.map(embedOne);
    },
  };
}
