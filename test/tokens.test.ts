import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { distinctiveTokens } from "@/server/rag/tokens";

/**
 * This function decides whether the lexical arm runs at all, which makes it
 * the whole safety story for hybrid retrieval.
 *
 * Return nothing and retrieval is byte-identical to vector-only search — the
 * "Not found in your knowledge base." path is reached exactly as before, with
 * no model call. Return something and chunks the vector arm scored below
 * RAG_MIN_SCORE become eligible. So the bar is deliberately high: a token has
 * to look like a part number, not like prose. A word carries no digits, and a
 * bare number is far more often a year, a quantity or a price than an
 * identifier.
 */
describe("distinctiveTokens", () => {
  it("finds a hyphenated part number", () => {
    assert.deepEqual(distinctiveTokens("is ddr5-6000 worth it?"), ["ddr5-6000"]);
  });

  it("finds a token that mixes letters and digits", () => {
    assert.deepEqual(distinctiveTokens("what CL30 timing?"), ["cl30"]);
  });

  it("ignores bare numbers, which are usually prose", () => {
    assert.deepEqual(distinctiveTokens("is 5600 enough in 2016?"), []);
  });

  it("ignores ordinary words", () => {
    assert.deepEqual(distinctiveTokens("how do I size a power supply?"), []);
  });

  it("ignores tokens too short to be an identifier", () => {
    // "a1" and "b2" are DIMM slots in the seed corpus and would match half of
    // it. Three characters is the shortest real part number here (AM5, PL2).
    assert.deepEqual(distinctiveTokens("slot a1 or b2?"), []);
  });

  it("strips punctuation from around a token", () => {
    assert.deepEqual(distinctiveTokens("the B650E, really?"), ["b650e"]);
  });

  it("returns each token once, however it was capitalised", () => {
    assert.deepEqual(distinctiveTokens("ddr5-6000 vs DDR5-6000"), ["ddr5-6000"]);
  });

  it("finds every distinctive token in a question", () => {
    assert.deepEqual(distinctiveTokens("ddr5-6000 CL30 on a B650E board"), [
      "ddr5-6000",
      "cl30",
      "b650e",
    ]);
  });

  it("returns nothing for an empty question", () => {
    assert.deepEqual(distinctiveTokens(""), []);
  });
});
