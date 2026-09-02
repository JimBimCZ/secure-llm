/**
 * Turning an uploaded file into plain text. One function per accepted format,
 * chosen by extension — the three accepted formats (CLAUDE.md §6).
 */

export const ACCEPTED_EXTENSIONS = [".md", ".txt", ".pdf"] as const;

export class UnsupportedFormatError extends Error {
  constructor(readonly filename: string) {
    super(`Unsupported file type. Accepted: ${ACCEPTED_EXTENSIONS.join(", ")}`);
    this.name = "UnsupportedFormatError";
  }
}

function extensionOf(filename: string): string {
  const at = filename.lastIndexOf(".");
  return at === -1 ? "" : filename.slice(at).toLowerCase();
}

async function extractPdf(bytes: Uint8Array): Promise<string> {
  // unpdf bundles its own pdf.js build and has no dependencies of its own.
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
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
