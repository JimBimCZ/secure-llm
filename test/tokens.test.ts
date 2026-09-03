import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { distinctiveTerms } from "@/server/rag/tokens";

/**
 * This function decides whether the lexical arm runs at all, which makes it
 * the whole safety story for hybrid retrieval.
 *
 * Return nothing and retrieval is byte-identical to vector-only search — the
 * "Not found in your knowledge base." path is reached exactly as before, with
 * no model call. Return something and chunks the vector arm scored below
 * RAG_MIN_SCORE become eligible. So the bar is deliberately high: a term has
 * to look like a part number, not like prose.
 */
describe("distinctiveTerms", () => {
  it("finds a hyphenated part number", () => {
    assert.deepEqual(distinctiveTerms("is ddr5-6000 worth it?"), ["ddr5-6000"]);
  });

  it("finds a token that mixes letters and digits", () => {
    assert.deepEqual(distinctiveTerms("what CL30 timing?"), ["cl30"]);
  });

  it("ignores bare numbers, which are usually prose", () => {
    assert.deepEqual(distinctiveTerms("is 5600 enough in 2016?"), []);
  });

  it("ignores ordinary words", () => {
    assert.deepEqual(distinctiveTerms("how do I size a power supply?"), []);
  });

  it("ignores tokens too short to be an identifier", () => {
    // "a1" and "b2" are DIMM slots in the seed corpus and would match half of
    // it. Three characters is the shortest real part number here (AM5, PL2).
    assert.deepEqual(distinctiveTerms("slot a1 or b2?"), []);
  });

  it("strips punctuation from around a token", () => {
    assert.deepEqual(distinctiveTerms("the B650E, really?"), ["b650e"]);
  });

  it("returns each term once, however it was capitalised", () => {
    assert.deepEqual(distinctiveTerms("ddr5-6000 vs DDR5-6000"), ["ddr5-6000"]);
  });

  it("finds every distinctive term in a question", () => {
    assert.deepEqual(distinctiveTerms("ddr5-6000 CL30 on a B650E board"), [
      "ddr5-6000",
      "cl30",
      "b650e",
    ]);
  });

  it("returns nothing for an empty question", () => {
    assert.deepEqual(distinctiveTerms(""), []);
  });

  /**
   * The identifier written as two tokens. `LGA 1718` is in the seed corpus and
   * neither half qualifies alone: `lga` carries no digit and `1718` no letter.
   * Measured before this rule existed, the question below was REFUSED at a
   * top score of 0.236 against a 0.25 floor, from a corpus that contains it.
   *
   * The pair is searched for as a phrase, so the bare number is only ever
   * looked for immediately after the word that makes it an identifier. That is
   * what keeps admitting `1718` from being the same thing as admitting `2016`.
   */
  describe("a short word followed by a number", () => {
    it("pairs a socket designation written as two tokens", () => {
      assert.deepEqual(distinctiveTerms("What did I write about LGA 1718?"), [
        "lga 1718",
      ]);
    });

    it("keeps the two versions of a bus apart", () => {
      // The whole point, and the exact shape of the ddr5-6000 vs ddr5-5600
      // failure: to a sentence embedder these two say the same thing.
      assert.deepEqual(distinctiveTerms("PCIe 4.0 or PCIe 5.0 for the GPU?"), [
        "pcie 4.0",
        "pcie 5.0",
      ]);
    });

    it("pairs whichever way the user capitalised it", () => {
      // People type into a search box in lower case. A rule that only works
      // when the shift key was used is one that fails in front of an audience.
      assert.deepEqual(distinctiveTerms("is lga 1851 the same as LGA 1700?"), [
        "lga 1851",
        "lga 1700",
      ]);
    });

    it("does not pair a function word with a year", () => {
      assert.deepEqual(distinctiveTerms("what did I buy in 2024?"), []);
      assert.deepEqual(distinctiveTerms("anything since 2023?"), []);
      assert.deepEqual(distinctiveTerms("was it under 1500 or over 2000?"), []);
    });

    it("does not pair a word long enough to be prose", () => {
      // Five characters is where identifiers stop and sentences start. The
      // cost is real — "Ryzen 9" is not found — and it is in the README.
      assert.deepEqual(distinctiveTerms("the memory 6000 kit"), []);
    });

    it("requires two digits, so a version fragment is not an identifier", () => {
      // "Ryzen 9" is a real product name and this rule does not find it. One
      // digit after a word is more often a count than a part number.
      assert.deepEqual(distinctiveTerms("Ryzen 9 on a B650E board"), ["b650e"]);
    });

    it("leaves a word that already carries a digit alone", () => {
      // "ddr5" is a term on its own. Pairing it as well would demand the two
      // sit adjacent in the chunk, which is stricter than today for no gain.
      assert.deepEqual(distinctiveTerms("ddr5 6000 CL30"), ["ddr5", "cl30"]);
    });

    it("does not pair across punctuation", () => {
      // Adjacency is the evidence that the two halves are one identifier.
      assert.deepEqual(distinctiveTerms("the slot, 1700 pins"), []);
    });
  });
});
