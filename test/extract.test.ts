import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  extractDocumentText,
  UnsupportedFormatError,
} from "@/server/rag/extract";

const seed = (name: string) =>
  new Uint8Array(
    readFileSync(path.join(import.meta.dirname, "..", "seed", name)),
  );

const utf8 = (text: string) => new TextEncoder().encode(text);

/**
 * The fixture is the seed PDF the app itself ships, not a synthetic one: it is
 * the file that produced the defect, and a test that fixes a different file
 * proves nothing. It is committed, so this stays deterministic and offline.
 */
describe("extractDocumentText", () => {
  it("reads .md and .txt through untouched", async () => {
    const text = "# Heading\n\nA line.\nAnother line.\n";

    assert.equal(await extractDocumentText("a.md", utf8(text)), text);
    assert.equal(await extractDocumentText("a.txt", utf8(text)), text);
  });

  it("refuses a format it cannot read", async () => {
    await assert.rejects(
      () => extractDocumentText("a.docx", utf8("x")),
      UnsupportedFormatError,
    );
  });

  describe("pdf", () => {
    let text = "";

    it("extracts the document", async () => {
      text = await extractDocumentText(
        "10-networking-nic.pdf",
        seed("10-networking-nic.pdf"),
      );

      assert.ok(text.length > 2_000);
    });

    it("rejoins words the page layout split across a line", async () => {
      // Each of these arrived as "compar\ning", "P\nCIe", "NV\nMe" — the page
      // is laid out at a fixed column and cuts wherever the column falls.
      for (const word of [
        "are not",
        "comparing boards",
        "PCIe 3.0",
        "NVMe drives",
        "everything behind",
        "buying today",
      ]) {
        assert.ok(text.includes(word), `expected to find ${JSON.stringify(word)}`);
      }
    });

    it("keeps the space when the layout cut at one", async () => {
      // The other half of the same problem: a cut that lands on a space must
      // not glue the two words together while fixing the split ones.
      for (const phrase of [
        "considerably; the hardware",
        "certain switches,",
        'the "my connection',
      ]) {
        assert.ok(
          text.includes(phrase),
          `expected to find ${JSON.stringify(phrase)}`,
        );
      }
    });

    it("keeps the line breaks that were really in the document", async () => {
      // A heading followed by its paragraph. Joining everything into one line
      // would fix the split words and destroy the structure instead.
      assert.match(text, /latency\n/);
      assert.ok(text.split("\n").length > 10);
    });
  });
});
