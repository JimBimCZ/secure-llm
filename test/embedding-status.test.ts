import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeStaleness } from "@/server/rag/embeddingStatus";

const ACTIVE = "Xenova/all-MiniLM-L6-v2";

/**
 * Retrieval filters on the embedding model that produced each vector, because
 * vectors from two models are not comparable. The consequence is that changing
 * the embedder does not degrade the app — it empties it. Every question comes
 * back "Not found in your knowledge base." while the documents page still
 * reports ten documents and fifty-three chunks.
 *
 * That behaviour is right and the silence about it is not. This function turns
 * the one thing the database can say — how many chunks each model produced —
 * into the sentence the UI needs, and it is the half of the feature that can be
 * tested without a connection.
 */
describe("describeStaleness", () => {
  it("reports nothing stale for a user with no chunks at all", () => {
    const status = describeStaleness([], ACTIVE);

    assert.deepEqual(status.stale, []);
    assert.equal(status.currentChunks, 0);
    assert.equal(status.staleChunks, 0);
  });

  it("reports nothing stale when every chunk came from the active model", () => {
    // The overwhelmingly common case: nobody has touched the configuration, and
    // the notice must render nothing at all rather than a reassuring banner.
    const status = describeStaleness(
      [{ model: ACTIVE, chunks: 53, documents: 10 }],
      ACTIVE,
    );

    assert.deepEqual(status.stale, []);
    assert.equal(status.currentChunks, 53);
    assert.equal(status.staleChunks, 0);
  });

  it("counts chunks from another model as stale, and keeps them out of the current count", () => {
    const status = describeStaleness(
      [
        { model: "mock-hashing-v1", chunks: 53, documents: 10 },
        { model: ACTIVE, chunks: 4, documents: 1 },
      ],
      ACTIVE,
    );

    assert.equal(status.currentChunks, 4);
    assert.equal(status.staleChunks, 53);
    assert.deepEqual(status.stale, [
      { model: "mock-hashing-v1", chunks: 53, documents: 10 },
    ]);
  });

  it("handles the whole corpus being unsearchable", () => {
    // Switching the embedder against an existing database. Nothing is
    // retrievable, and this is the state the app used to say nothing about.
    const status = describeStaleness(
      [{ model: "mock-hashing-v1", chunks: 53, documents: 10 }],
      ACTIVE,
    );

    assert.equal(status.currentChunks, 0);
    assert.equal(status.staleChunks, 53);
    assert.equal(status.stale.length, 1);
  });

  it("lists several stale models, largest first", () => {
    // Reachable by switching embedder twice, or by re-embedding part way and
    // stopping. The banner names each one, because "some other model" is not
    // something a reader can act on.
    const status = describeStaleness(
      [
        { model: "older-model", chunks: 7, documents: 2 },
        { model: "mock-hashing-v1", chunks: 53, documents: 10 },
        { model: ACTIVE, chunks: 4, documents: 1 },
      ],
      ACTIVE,
    );

    assert.deepEqual(
      status.stale.map((row) => row.model),
      ["mock-hashing-v1", "older-model"],
    );
    assert.equal(status.staleChunks, 60);
  });

  it("names the active model, so the notice can say what retrieval is using", () => {
    assert.equal(describeStaleness([], ACTIVE).activeModel, ACTIVE);
  });
});
