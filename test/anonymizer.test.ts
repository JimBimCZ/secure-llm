import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAnonymizer } from "@/server/privacy/anonymizer";

/**
 * The round trip is the property that matters: whatever leaves must be able to
 * come back unchanged. Everything else is a detail of how it gets there.
 */
describe("anonymizer", () => {
  it("restores exactly what it redacted", () => {
    const a = createAnonymizer();
    const original =
      "Marek Dvořák (marek.dvorak@example.com, +420 601 234 567) said the board was fine.";

    const redacted = a.redact(original);

    assert.notEqual(redacted, original);
    assert.equal(a.restore(redacted), original);
  });

  it("removes every e-mail, phone and known name from the redacted text", () => {
    const a = createAnonymizer();
    const redacted = a.redact(
      "Ask Petra Horáková at petra.horakova@example.com or +420 603 456 789.",
    );

    assert.doesNotMatch(redacted, /@example\.com/);
    assert.doesNotMatch(redacted, /\+420/);
    assert.doesNotMatch(redacted, /Petra|Horáková/);
    assert.match(redacted, /\[EMAIL_1\]/);
    assert.match(redacted, /\[PHONE_1\]/);
    assert.match(redacted, /\[PERSON_1\]/);
  });

  it("gives one value one placeholder, across separate redact calls", () => {
    // This is what lets a question about a person still match a chunk about
    // that person: both are redacted by the same instance, so both say
    // [PERSON_1]. Without it, retrieval context and question would disagree.
    const a = createAnonymizer();

    const question = a.redact("What did David Kraus recommend?");
    const chunk = a.redact("David Kraus set up the CAKE configuration.");

    assert.match(question, /\[PERSON_1\]/);
    assert.match(chunk, /\[PERSON_1\]/);
    assert.equal(a.counts().persons, 1);
  });

  it("gives different values different placeholders", () => {
    const a = createAnonymizer();
    const redacted = a.redact(
      "marek.dvorak@example.com and lucie.simkova@example.com",
    );

    assert.match(redacted, /\[EMAIL_1\]/);
    assert.match(redacted, /\[EMAIL_2\]/);
    assert.equal(a.counts().emails, 2);
  });

  it("keeps separate instances separate", () => {
    // One anonymizer per request. If two requests shared one, restore() could
    // put one user's name into another user's answer.
    const a = createAnonymizer();
    const b = createAnonymizer();

    a.redact("David Kraus");
    const leaked = b.restore("[PERSON_1]");

    assert.equal(leaked, "[PERSON_1]");
  });

  it("does not join two paragraphs into a person", () => {
    // Regression: with `\s+` as the separator the bigram jumped a blank line
    // and redacted "Undervolting\n\nSame" as a person.
    const a = createAnonymizer();
    const redacted = a.redact("## Undervolting\n\nSame settings as before.");

    assert.equal(redacted, "## Undervolting\n\nSame settings as before.");
    assert.equal(a.counts().persons, 0);
  });

  it("does not redact a capitalised word that merely starts a sentence", () => {
    const a = createAnonymizer();
    const redacted = a.redact("The Ryzen chip is fine. On Intel it differs.");

    assert.doesNotMatch(redacted, /PERSON/);
  });

  it("leaves text with nothing personal in it untouched", () => {
    const a = createAnonymizer();
    const plain = "A 1 TB consumer TLC drive is rated around 600 TBW.";

    assert.equal(a.redact(plain), plain);
    assert.deepEqual(a.counts(), { persons: 0, emails: 0, phones: 0 });
  });

  it("does not mistake technical figures for phone numbers", () => {
    const a = createAnonymizer();
    const redacted = a.redact("Runs at 3200 MHz, rated 600 TBW, 100 µs spike.");

    assert.equal(a.counts().phones, 0);
    assert.equal(redacted, "Runs at 3200 MHz, rated 600 TBW, 100 µs spike.");
  });

  it("counts distinct values, not occurrences", () => {
    const a = createAnonymizer();
    a.redact("David Kraus, David Kraus, and David Kraus again.");

    assert.equal(a.counts().persons, 1);
  });

  it("restores a placeholder wherever the model put it", () => {
    const a = createAnonymizer();
    a.redact("Ask marek.dvorak@example.com about it.");

    const modelAnswer = "You should contact [EMAIL_1] directly.";

    assert.equal(
      a.restore(modelAnswer),
      "You should contact marek.dvorak@example.com directly.",
    );
  });
});
