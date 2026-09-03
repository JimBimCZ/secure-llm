import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readPartial } from "@/server/ai/partialJson";

describe("readPartial", () => {
  it("returns null citations until the array closes", () => {
    assert.equal(readPartial('{"citations": [1, 2').citations, null);
    assert.deepEqual(readPartial('{"citations": [1, 2]').citations, [1, 2]);
  });

  it("reads the answer as far as it has arrived", () => {
    const partial = '{"citations": [1], "answer": "The PSU is rated';
    assert.equal(readPartial(partial).answerSoFar, "The PSU is rated");
  });

  it("decodes escapes inside the answer", () => {
    const json = '{"citations": [1], "answer": "a \\"quote\\" and a \\\\ and \\n"';
    assert.equal(readPartial(json).answerSoFar, 'a "quote" and a \\ and \n');
  });

  it("holds back a half-arrived escape rather than guessing", () => {
    assert.equal(readPartial('{"answer": "ab\\').answerSoFar, "ab");
    assert.equal(readPartial('{"answer": "ab\\u00').answerSoFar, "ab");
    assert.equal(readPartial('{"answer": "ab\\u00e9').answerSoFar, "abé");
  });

  it("stops at the closing quote", () => {
    const done = '{"citations": [1], "answer": "done"}';
    assert.equal(readPartial(done).answerSoFar, "done");
  });

  it("survives a field order the prompt did not ask for", () => {
    const reversed = '{"answer": "text", "citations": [2]}';
    assert.deepEqual(readPartial(reversed).citations, [2]);
    assert.equal(readPartial(reversed).answerSoFar, "text");
  });

  it("never throws on malformed input", () => {
    for (const bad of ["", "not json", "{", '{"citations": "nope"}', '{"citations": [1,]']) {
      assert.doesNotThrow(() => readPartial(bad));
    }
  });
});
