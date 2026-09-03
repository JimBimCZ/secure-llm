import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fuseByRank } from "@/server/rag/fuse";

const chunk = (id: string) => ({ id });

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

const arm = (arm: "vector" | "lexical" | "prose", ...rows: string[]) => ({
  arm,
  rows: rows.map(chunk),
});

/**
 * Fusion decides ORDER and nothing else. The arms' input lists have already
 * been filtered in SQL — by owner, by embedding model, and each by its own
 * notion of "relevant enough" — so there is no admission decision left to
 * take here, and this function must never be the reason a chunk is dropped
 * or kept.
 *
 * Reciprocal rank fusion, because the arms score in units that cannot be
 * compared: a cosine similarity in [0, 1] and a text rank that is unbounded and
 * corpus-dependent. Ranks are comparable; the scores behind them are not.
 */
describe("fuseByRank", () => {
  it("preserves an arm's order when it is the only one that found anything", () => {
    const fused = fuseByRank(
      [arm("vector", "a", "b", "c"), arm("lexical"), arm("prose")],
      10,
    );

    assert.deepEqual(ids(fused), ["a", "b", "c"]);
  });

  it("keeps a chunk only the prose arm found", () => {
    // The point of slice 14: this chunk scored below RAG_MIN_SCORE because the
    // embedder could not recognise the user's own phrasing, and the term
    // overlap is the evidence of relevance instead.
    const fused = fuseByRank(
      [arm("vector", "a"), arm("lexical"), arm("prose", "b")],
      10,
    );

    assert.deepEqual(ids(fused).sort(), ["a", "b"]);
  });

  it("ranks a chunk two arms found above a chunk one arm found", () => {
    const fused = fuseByRank(
      [arm("vector", "a", "b"), arm("lexical"), arm("prose", "c", "b")],
      10,
    );

    assert.equal(fused[0]?.id, "b");
  });

  it("ranks a chunk all three arms found highest of all", () => {
    const fused = fuseByRank(
      [arm("vector", "a", "b"), arm("lexical", "c", "b"), arm("prose", "c", "b")],
      10,
    );

    assert.equal(fused[0]?.id, "b");
  });

  it("records every arm that found a chunk, in the order the arms were given", () => {
    const fused = fuseByRank(
      [arm("vector", "a", "b"), arm("lexical", "c", "b"), arm("prose", "b")],
      10,
    );
    const provenance = Object.fromEntries(fused.map((r) => [r.id, r.matchedBy]));

    assert.deepEqual(provenance, {
      a: ["vector"],
      b: ["vector", "lexical", "prose"],
      c: ["lexical"],
    });
  });

  it("breaks ties towards the arm given first", () => {
    // Both arms rank their chunk first and neither found the other's, so the
    // reciprocal contributions are identical. Vector is passed first because
    // semantic similarity is the safer default.
    const fused = fuseByRank([arm("vector", "a"), arm("prose", "b")], 10);

    assert.deepEqual(ids(fused), ["a", "b"]);
  });

  it("returns at most the limit", () => {
    const fused = fuseByRank(
      [arm("vector", "a", "b"), arm("lexical", "c"), arm("prose", "d")],
      2,
    );

    assert.equal(fused.length, 2);
  });

  it("returns nothing when no arm found anything", () => {
    // Retrieval's empty result is what produces "Not found in your knowledge
    // base." without a model call, so fusion has to pass emptiness through.
    assert.deepEqual(fuseByRank([arm("vector"), arm("lexical"), arm("prose")], 10), []);
  });
});
