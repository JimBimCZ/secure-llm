import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fuseByRank } from "@/server/rag/fuse";

const chunk = (id: string) => ({ id });

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

/**
 * Fusion decides ORDER and nothing else. Both input lists have already been
 * filtered in SQL — by owner, by embedding model, and each by its own notion
 * of "relevant enough" — so there is no admission decision left to take here,
 * and this function must never be the reason a chunk is dropped or kept.
 *
 * Reciprocal rank fusion, because the two arms score in units that cannot be
 * compared: a cosine similarity in [0, 1] and a text rank that is unbounded and
 * corpus-dependent. Ranks are comparable; the scores behind them are not.
 */
describe("fuseByRank", () => {
  it("preserves the vector arm's order when the lexical arm found nothing", () => {
    // The common case, and the one that must not regress: no distinctive token
    // in the question means retrieval behaves exactly as it did before.
    const fused = fuseByRank([chunk("a"), chunk("b"), chunk("c")], [], 10);

    assert.deepEqual(ids(fused), ["a", "b", "c"]);
  });

  it("keeps a chunk only the lexical arm found", () => {
    // The entire point. This chunk scored below RAG_MIN_SCORE — the embedder
    // could not see the part number — and the exact match is the evidence of
    // relevance instead.
    const fused = fuseByRank([chunk("a")], [chunk("b")], 10);

    assert.deepEqual(ids(fused).sort(), ["a", "b"]);
  });

  it("ranks a chunk both arms found above a chunk only one arm found", () => {
    const fused = fuseByRank([chunk("a"), chunk("b")], [chunk("c"), chunk("b")], 10);

    assert.equal(fused[0]?.id, "b");
  });

  it("records which arm each chunk came from", () => {
    const fused = fuseByRank([chunk("a"), chunk("b")], [chunk("c"), chunk("b")], 10);
    const provenance = Object.fromEntries(fused.map((r) => [r.id, r.matchedBy]));

    assert.deepEqual(provenance, { a: "vector", b: "both", c: "lexical" });
  });

  it("returns at most the limit", () => {
    const fused = fuseByRank([chunk("a"), chunk("b")], [chunk("c")], 2);

    assert.equal(fused.length, 2);
  });

  it("returns nothing when neither arm found anything", () => {
    // Retrieval's empty result is what produces "Not found in your knowledge
    // base." without a model call, so fusion has to pass emptiness through.
    assert.deepEqual(fuseByRank([], [], 10), []);
  });
});
