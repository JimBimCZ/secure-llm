import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveCitations, type CitableChunk } from "@/server/rag/citations";

const chunk = (n: number): CitableChunk => ({
  id: `chunk-${n}`,
  documentId: `doc-${n}`,
  filename: `${n}.md`,
  chunkIndex: n,
  content: `content ${n}`,
});

const retrieved = [chunk(1), chunk(2), chunk(3)];

/**
 * The guard's whole job is deciding which claimed citations survive. An
 * answer with none surviving is rejected by the caller, so "drops it" here
 * means "costs the answer" there.
 */
describe("resolveCitations", () => {
  it("resolves positions to the chunks at those positions", () => {
    const citations = resolveCitations([1, 3], retrieved);

    assert.equal(citations.length, 2);
    assert.equal(citations[0]?.chunkId, "chunk-1");
    assert.equal(citations[1]?.chunkId, "chunk-3");
  });

  it("keeps the model's ordering, not the retrieval ordering", () => {
    const citations = resolveCitations([3, 1], retrieved);

    assert.deepEqual(
      citations.map((c) => c.chunkId),
      ["chunk-3", "chunk-1"],
    );
  });

  it("drops a citation past the end of the retrieved set", () => {
    // The fabrication case: the model cited [9] out of three sources.
    assert.deepEqual(resolveCitations([9], retrieved), []);
  });

  it("drops zero and negative positions", () => {
    // Citations are 1-based. A 0 means the model counted from the wrong end.
    assert.deepEqual(resolveCitations([0, -1], retrieved), []);
  });

  it("drops non-integer positions", () => {
    assert.deepEqual(resolveCitations([1.5, Number.NaN], retrieved), []);
  });

  it("keeps the valid citations when only some are fabricated", () => {
    // A partly-wrong answer is not thrown away wholesale: what is supported
    // stands, what is not is dropped.
    const citations = resolveCitations([2, 99], retrieved);

    assert.equal(citations.length, 1);
    assert.equal(citations[0]?.chunkId, "chunk-2");
  });

  it("de-duplicates a position cited twice", () => {
    const citations = resolveCitations([2, 2, 2], retrieved);

    assert.equal(citations.length, 1);
  });

  it("returns nothing when the model cited nothing", () => {
    assert.deepEqual(resolveCitations([], retrieved), []);
  });

  it("returns nothing when there was nothing to cite", () => {
    assert.deepEqual(resolveCitations([1], []), []);
  });

  it("carries the passage through, so the UI can show what was cited", () => {
    const [citation] = resolveCitations([2], retrieved);

    assert.equal(citation?.content, "content 2");
    assert.equal(citation?.filename, "2.md");
    assert.equal(citation?.chunkIndex, 2);
  });
});
