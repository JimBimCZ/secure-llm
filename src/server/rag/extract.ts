/**
 * Turning an uploaded file into plain text. One function per accepted format,
 * chosen by extension — the three accepted formats (CLAUDE.md §6).
 */

export const ACCEPTED_EXTENSIONS = [".md", ".txt", ".pdf"] as const;

export class UnsupportedFormatError extends Error {
  // Assigned in the body rather than declared as a constructor parameter
  // property: the tests run on Node's type stripping, which refuses that
  // syntax because it is the one TypeScript feature that emits code.
  readonly filename: string;

  constructor(filename: string) {
    super(`Unsupported file type. Accepted: ${ACCEPTED_EXTENSIONS.join(", ")}`);
    this.name = "UnsupportedFormatError";
    this.filename = filename;
  }
}

function extensionOf(filename: string): string {
  const at = filename.lastIndexOf(".");
  return at === -1 ? "" : filename.slice(at).toLowerCase();
}

/**
 * What a PDF actually contains: positioned runs of glyphs, with no notion of a
 * word or a paragraph. `hasEOL` marks the end of a rendered line, and that is
 * all the structure there is.
 */
interface TextItem {
  str: string;
  width: number;
  /** [a, b, c, d, x, y] — only the x translation is used here. */
  transform: number[];
  hasEOL?: boolean;
}

interface Line {
  text: string;
  left: number;
  right: number;
}

function toLines(items: TextItem[]): Line[] {
  const lines: Line[] = [];
  let current: TextItem[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const first = current[0]!;
    const last = current[current.length - 1]!;
    lines.push({
      text: current.map((item) => item.str).join(""),
      left: first.transform[4]!,
      right: last.transform[4]! + last.width,
    });
    current = [];
  };

  for (const item of items) {
    // Marked-content items carry no text and no position.
    if (typeof item.str !== "string") continue;
    current.push(item);
    if (item.hasEOL) flush();
  }
  flush();

  return lines.filter((line) => line.text.trim().length > 0);
}

/**
 * Puts back the line breaks that belong to the document and removes the ones
 * the page layout invented.
 *
 * A PDF stores lines, not sentences. When the text was laid out at a fixed
 * column, a line ends wherever the column fell — which is regularly in the
 * middle of a word. Joining every line with "\n", which is what a naive
 * extractor does, is how `"comparing"` reaches the index as `"compar\ning"`:
 * stored, citable, and invisible to a search for the word it actually is.
 *
 * The layout itself says which breaks are its own. A line the layout ended is
 * flush to the right margin; a line the author ended stops short of it. So:
 *
 * - Short of the margin — the author's line break. Keep it.
 * - Flush to the margin — the layout's. Join to the next line, with a space
 *   only if one was there: either the margin swallowed it (the line stops one
 *   character early) or it survives as the next line's indent. Flush on both
 *   sides means the word was cut, and the halves go back together.
 *
 * Tolerances are in units of the line's own average character width, so this
 * does not assume a monospaced font or a page size. A PDF that wraps on word
 * boundaries has a ragged right edge, no line is flush, and every break is
 * kept — which is the old behaviour, and correct, because such a file has no
 * split words to repair.
 */
function reflow(lines: Line[]): string {
  if (lines.length === 0) return "";

  const margin = Math.max(...lines.map((line) => line.right));
  const indent = Math.min(...lines.map((line) => line.left));

  let out = "";

  for (const [i, line] of lines.entries()) {
    out += line.text.trimEnd();

    const next = lines[i + 1];
    if (!next) break;

    // Average advance per character on this line. Written per line because a
    // heading and its body are not the same size.
    const charWidth = (line.right - line.left) / Math.max(line.text.length, 1);
    const shortBy = margin - line.right;

    if (shortBy > 1.5 * charWidth) {
      out += "\n";
      continue;
    }

    const spaceWasThere =
      shortBy > 0.5 * charWidth || next.left - indent > 0.5 * charWidth;
    out += spaceWasThere ? " " : "";
  }

  return out;
}

async function extractPdf(bytes: Uint8Array): Promise<string> {
  // unpdf bundles its own pdf.js build and has no dependencies of its own.
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);

  const pages: string[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const { items } = await page.getTextContent();
    pages.push(reflow(toLines(items as TextItem[])));
  }

  // A page break is a paragraph break at least. There is nothing in the file
  // that says whether a sentence continues across it.
  return pages.join("\n\n");
}

export async function extractDocumentText(
  filename: string,
  bytes: Uint8Array,
): Promise<string> {
  const extension = extensionOf(filename);

  switch (extension) {
    case ".md":
    case ".txt":
      return new TextDecoder("utf-8").decode(bytes);
    case ".pdf":
      return extractPdf(bytes);
    default:
      throw new UnsupportedFormatError(filename);
  }
}
