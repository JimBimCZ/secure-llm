import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { personsIn, windows, WINDOW_CHARS } from "@/server/privacy/detectors/ner";

/**
 * The model itself is not tested here — this suite loads no model, for the
 * same reason it opens no database connection. What is tested is the code
 * around it: the windowing that stops a name being silently dropped past the
 * model's 512-token limit, and the stitching that turns wordpieces back into
 * something the anonymizer can find.
 */
describe("ner detector windowing", () => {
  it("returns a short text as a single window", () => {
    assert.deepEqual(windows("Ask Marek Dvořák about it."), ["Ask Marek Dvořák about it."]);
  });

  it("never returns a window longer than the budget", () => {
    const paragraph = "Sentence about storage endurance. ".repeat(200);
    const text = `${paragraph}\n\n${paragraph}\n\n${paragraph}`;

    for (const window of windows(text)) {
      assert.ok(
        window.length <= WINDOW_CHARS,
        `window of ${window.length} chars exceeds the ${WINDOW_CHARS} budget`,
      );
    }
  });

  it("splits between paragraphs rather than inside one", () => {
    const a = "A".repeat(WINDOW_CHARS - 100);
    const b = "B".repeat(WINDOW_CHARS - 100);

    assert.deepEqual(windows(`${a}\n\n${b}`), [a, b]);
  });

  it("overlaps a hard split, so a name at the seam survives in one piece", () => {
    // One paragraph over the budget has to be cut somewhere, and a cut through
    // a name would lose it: neither half is a name the anonymizer can find.
    const filler = "x".repeat(WINDOW_CHARS - 10);
    const text = `${filler}Petra Horáková is here.`;

    const found = windows(text);

    assert.ok(found.length > 1, "expected the over-long paragraph to be split");
    assert.ok(
      found.some((w) => w.includes("Petra Horáková")),
      "a name at the split seam must appear whole in some window",
    );
  });

  it("keeps a name that sits in a later paragraph", () => {
    const text = "First paragraph.\n\nSecond paragraph mentioning Lucie Šimková.";

    assert.ok(windows(text).some((w) => w.includes("Lucie Šimková")));
  });

  it("counts the paragraph separator in the buffer merge check", () => {
    // Two paragraphs of 800 and 736 chars sum to 1536, but adding the "\n\n"
    // separator (2 chars) makes 1538, exceeding WINDOW_CHARS. Without fixing
    // the merge check to account for the separator, both paragraphs merge into
    // a single window that exceeds the budget.
    const a = "A".repeat(800);
    const b = "B".repeat(736);
    const text = `${a}\n\n${b}`;

    const found = windows(text);

    for (const window of found) {
      assert.ok(
        window.length <= WINDOW_CHARS,
        `merged window of ${window.length} chars exceeds the ${WINDOW_CHARS} budget`,
      );
    }
  });
});

describe("ner detector stitching", () => {
  const window = "Petra Horáková and Marek Dvořák met.";

  it("stitches wordpieces back into a surface form", () => {
    const found = personsIn(
      [
        { entity: "B-PER", word: "Petra" },
        { entity: "I-PER", word: "Ho" },
        { entity: "I-PER", word: "##rá" },
        { entity: "I-PER", word: "##ková" },
      ],
      window,
    );

    assert.deepEqual(found, ["Petra Horáková"]);
  });

  it("separates two people that sit next to each other", () => {
    const found = personsIn(
      [
        { entity: "B-PER", word: "Petra" },
        { entity: "I-PER", word: "Ho" },
        { entity: "I-PER", word: "##rá" },
        { entity: "I-PER", word: "##ková" },
        { entity: "O", word: "and" },
        { entity: "B-PER", word: "Marek" },
        { entity: "I-PER", word: "D" },
        { entity: "I-PER", word: "##voř" },
        { entity: "I-PER", word: "##ák" },
      ],
      window,
    );

    assert.deepEqual(found, ["Petra Horáková", "Marek Dvořák"]);
  });

  it("drops a stitched form that is not in the window", () => {
    // The rejected model tagged the pieces of "Radek Pokorný" discontinuously
    // and stitching them gave "Poný", which is in no text anywhere. It must not
    // be reported: the anonymizer would not find it either, and a detector
    // that reports strings it did not see is a detector nobody can reason about.
    const found = personsIn(
      [
        { entity: "B-PER", word: "Po" },
        { entity: "I-PER", word: "##ný" },
      ],
      window,
    );

    assert.deepEqual(found, []);
  });

  it("ignores every tag that is not a person", () => {
    const found = personsIn(
      [
        { entity: "B-ORG", word: "Intel" },
        { entity: "B-LOC", word: "Brno" },
        { entity: "O", word: "shipped" },
      ],
      window,
    );

    assert.deepEqual(found, []);
  });

  it("rejects a blank name from a lone wordpiece fragment", () => {
    // A lone I-PER token with "##" yields an empty string when stitched.
    // The detector must not report it.
    const found = personsIn(
      [
        { entity: "I-PER", word: "##" },
      ],
      window,
    );

    assert.deepEqual(found, []);
  });

  it("rejects a name that is only whitespace", () => {
    // A B-PER token with only whitespace also stitches to a blank value.
    const found = personsIn(
      [
        { entity: "B-PER", word: " " },
      ],
      window,
    );

    assert.deepEqual(found, []);
  });
});
