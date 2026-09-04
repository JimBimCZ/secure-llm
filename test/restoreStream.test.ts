import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRestorer } from "@/server/privacy/restoreStream";

/** Stands in for the real anonymizer's mapping. */
const restore = (text: string) => text.replaceAll("[PERSON_1]", "Marek Dvořák");

describe("createRestorer", () => {
  it("restores a placeholder that arrives whole", () => {
    const r = createRestorer(restore);
    assert.equal(r.push("hi [PERSON_1] there"), "hi Marek Dvořák there");
    assert.equal(r.flush(), "");
  });

  it("restores a placeholder split across every internal boundary", () => {
    const whole = "before [PERSON_1] after";
    for (let cut = 0; cut < whole.length; cut += 1) {
      const r = createRestorer(restore);
      const out = r.push(whole.slice(0, cut)) + r.push(whole.slice(cut)) + r.flush();
      assert.equal(out, "before Marek Dvořák after", `split at ${cut}`);
    }
  });

  it("does not hold text back forever for a bracket that is not a placeholder", () => {
    const r = createRestorer(restore);
    const out = r.push("see [1] and a lot more text after it that should not be held");
    assert.match(out, /should not be held/);
  });

  it("emits a trailing unterminated bracket on flush", () => {
    const r = createRestorer(restore);
    assert.equal(r.push("ends with ["), "ends with ");
    assert.equal(r.flush(), "[");
  });

  it("passes text with no placeholders straight through", () => {
    const r = createRestorer(restore);
    assert.equal(r.push("nothing to do here"), "nothing to do here");
  });
});
