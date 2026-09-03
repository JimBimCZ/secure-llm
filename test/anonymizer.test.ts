import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAnonymizer } from "@/server/privacy/anonymizer";
import { createHeuristicDetector } from "@/server/privacy/detectors/heuristic";
import type { PersonDetector } from "@/server/privacy/detectors/types";

/**
 * The round trip is the property that matters: whatever leaves must be able to
 * come back unchanged. Everything else is a detail of how it gets there.
 */
describe("anonymizer", () => {
  it("restores exactly what it redacted", async () => {
    const a = createAnonymizer(createHeuristicDetector());
    const original =
      "Marek Dvořák (marek.dvorak@example.com, +420 601 234 567) said the board was fine.";

    const redacted = await a.redact(original);

    assert.notEqual(redacted, original);
    assert.equal(a.restore(redacted), original);
  });

  it("removes every e-mail, phone and known name from the redacted text", async () => {
    const a = createAnonymizer(createHeuristicDetector());
    const redacted = await a.redact(
      "Ask Petra Horáková at petra.horakova@example.com or +420 603 456 789.",
    );

    assert.doesNotMatch(redacted, /@example\.com/);
    assert.doesNotMatch(redacted, /\+420/);
    assert.doesNotMatch(redacted, /Petra|Horáková/);
    assert.match(redacted, /\[EMAIL_1\]/);
    assert.match(redacted, /\[PHONE_1\]/);
    assert.match(redacted, /\[PERSON_1\]/);
  });

  it("gives one value one placeholder, across separate redact calls", async () => {
    // This is what lets a question about a person still match a chunk about
    // that person: both are redacted by the same instance, so both say
    // [PERSON_1]. Without it, retrieval context and question would disagree.
    const a = createAnonymizer(createHeuristicDetector());

    const question = await a.redact("What did David Kraus recommend?");
    const chunk = await a.redact("David Kraus set up the CAKE configuration.");

    assert.match(question, /\[PERSON_1\]/);
    assert.match(chunk, /\[PERSON_1\]/);
    assert.equal(a.counts().persons, 1);
  });

  it("gives different values different placeholders", async () => {
    const a = createAnonymizer(createHeuristicDetector());
    const redacted = await a.redact(
      "marek.dvorak@example.com and lucie.simkova@example.com",
    );

    assert.match(redacted, /\[EMAIL_1\]/);
    assert.match(redacted, /\[EMAIL_2\]/);
    assert.equal(a.counts().emails, 2);
  });

  it("keeps separate instances separate", async () => {
    // One anonymizer per request. If two requests shared one, restore() could
    // put one user's name into another user's answer.
    const a = createAnonymizer(createHeuristicDetector());
    const b = createAnonymizer(createHeuristicDetector());

    await a.redact("David Kraus");
    const leaked = b.restore("[PERSON_1]");

    assert.equal(leaked, "[PERSON_1]");
  });

  it("does not join two paragraphs into a person", async () => {
    // Regression: with `\s+` as the separator the bigram jumped a blank line
    // and redacted "Undervolting\n\nSame" as a person.
    const a = createAnonymizer(createHeuristicDetector());
    const redacted = await a.redact("## Undervolting\n\nSame settings as before.");

    assert.equal(redacted, "## Undervolting\n\nSame settings as before.");
    assert.equal(a.counts().persons, 0);
  });

  it("does not redact a capitalised word that merely starts a sentence", async () => {
    const a = createAnonymizer(createHeuristicDetector());
    const redacted = await a.redact("The Ryzen chip is fine. On Intel it differs.");

    assert.doesNotMatch(redacted, /PERSON/);
  });

  it("leaves text with nothing personal in it untouched", async () => {
    const a = createAnonymizer(createHeuristicDetector());
    const plain = "A 1 TB consumer TLC drive is rated around 600 TBW.";

    assert.equal(await a.redact(plain), plain);
    assert.deepEqual(a.counts(), { persons: 0, emails: 0, phones: 0 });
  });

  it("does not mistake technical figures for phone numbers", async () => {
    const a = createAnonymizer(createHeuristicDetector());
    const redacted = await a.redact("Runs at 3200 MHz, rated 600 TBW, 100 µs spike.");

    assert.equal(a.counts().phones, 0);
    assert.equal(redacted, "Runs at 3200 MHz, rated 600 TBW, 100 µs spike.");
  });

  it("counts distinct values, not occurrences", async () => {
    const a = createAnonymizer(createHeuristicDetector());
    await a.redact("David Kraus, David Kraus, and David Kraus again.");

    assert.equal(a.counts().persons, 1);
  });

  it("restores a placeholder wherever the model put it", async () => {
    const a = createAnonymizer(createHeuristicDetector());
    await a.redact("Ask marek.dvorak@example.com about it.");

    const modelAnswer = "You should contact [EMAIL_1] directly.";

    assert.equal(
      a.restore(modelAnswer),
      "You should contact marek.dvorak@example.com directly.",
    );
  });

  /**
   * A detector that reports exactly what it is told to. It is how the
   * anonymizer's own behaviour gets tested without loading a model — and it is
   * the only way to reach the cases a real detector reaches only by accident.
   */
  const stub = (...values: string[]): PersonDetector => ({
    name: "stub",
    async detect() {
      return values;
    },
    async warmUp() {},
  });

  it("replaces exactly what the detector reports, and nothing else", async () => {
    const a = createAnonymizer(stub("Arrow Lake"));

    const redacted = await a.redact("The Arrow Lake chip beat the Raptor Lake chip.");

    assert.equal(redacted, "The [PERSON_1] chip beat the Raptor Lake chip.");
    assert.equal(a.counts().persons, 1);
  });

  it("does nothing with a value that is not in the text", async () => {
    // The reconstruction-miss direction. A detector that stitches wordpieces
    // can produce a string the text never contained — the rejected NER model
    // produced "Poný" from "Radek Pokorný" — and the result must be a miss,
    // never a corruption, and never a counted redaction.
    const a = createAnonymizer(stub("Poný"));
    const text = "Radek Pokorný tuned the fan curve.";

    assert.equal(await a.redact(text), text);
    assert.equal(a.counts().persons, 0);
  });

  it("replaces the longest reported value first", async () => {
    // "Horáková" is a substring of "Petra Horáková". Shortest-first would
    // leave "Petra [PERSON_1]" — half a name, still readable as a person.
    const a = createAnonymizer(stub("Horáková", "Petra Horáková"));

    const redacted = await a.redact("Petra Horáková said so, and Horáková was right.");

    assert.equal(redacted, "[PERSON_1] said so, and [PERSON_2] was right.");
    assert.equal(a.restore(redacted), "Petra Horáková said so, and Horáková was right.");
  });

  it("still redacts an e-mail before a name found inside it", async () => {
    const a = createAnonymizer(stub("Dvorak"));

    const redacted = await a.redact("Write to marek.Dvorak@example.com today.");

    assert.equal(redacted, "Write to [EMAIL_1] today.");
    assert.equal(a.counts().persons, 0);
    assert.equal(a.counts().emails, 1);
  });

  it("numbers one detected value identically across separate redact calls", async () => {
    const a = createAnonymizer(stub("Tomáš Bednář"));

    const question = await a.redact("What did Tomáš Bednář measure?");
    const chunk = await a.redact("Tomáš Bednář measured the fan curve.");

    assert.match(question, /\[PERSON_1\]/);
    assert.match(chunk, /\[PERSON_1\]/);
    assert.equal(a.counts().persons, 1);
  });
});
