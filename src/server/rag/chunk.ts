/**
 * Splitting a document into retrievable pieces.
 *
 * The chunk size is set by the EMBEDDING MODEL'S INPUT WINDOW, not by taste.
 * all-MiniLM-L6-v2 accepts 512 tokens and silently truncates beyond that — the
 * text would still be stored and citable, but everything past the cut would be
 * invisible to retrieval, which looks like poor recall and is very hard to spot.
 * Measured before this limit was applied: 32 of 40 chunks overran it.
 *
 * Tokens are approximated as characters ÷ 3. That is deliberately pessimistic —
 * ordinary English prose runs closer to 4.8 characters per token, but tables and
 * code are far denser, and the cost of guessing low is a slightly smaller chunk
 * while the cost of guessing high is silent truncation.
 *
 * 1500 characters is therefore at most ~500 tokens even for dense input, and
 * ~310 for prose. Overlap is 300 characters so a passage that straddles a cut
 * still appears whole in one chunk.
 *
 * Cuts land on paragraph boundaries so a chunk is never half a sentence, and
 * every chunk keeps its character offsets so the UI can scroll the source
 * document to the cited passage.
 */

/** Pessimistic: dense text (tables, code) approaches this; prose is ~4.8. */
const CHARS_PER_TOKEN = 3;
/** all-MiniLM-L6-v2 truncates above this. Verified with the tokenizer. */
const MODEL_WINDOW_TOKENS = 512;

export const TARGET_CHARS = 500 * CHARS_PER_TOKEN;
export const OVERLAP_CHARS = 100 * CHARS_PER_TOKEN;

if (TARGET_CHARS / CHARS_PER_TOKEN > MODEL_WINDOW_TOKENS) {
  throw new Error("Chunk target exceeds the embedding model's input window");
}

export interface Chunk {
  index: number;
  content: string;
  startOffset: number;
  endOffset: number;
}

interface Paragraph {
  text: string;
  start: number;
  end: number;
}

/** Split on blank lines, keeping each paragraph's position in the original text. */
function paragraphs(text: string): Paragraph[] {
  const result: Paragraph[] = [];
  const pattern = /\n\s*\n/g;
  let start = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    result.push({ text: text.slice(start, match.index), start, end: match.index });
    start = match.index + match[0].length;
  }
  result.push({ text: text.slice(start), start, end: text.length });

  return result.filter((p) => p.text.trim().length > 0);
}

/**
 * A paragraph longer than the target on its own (a big table, a code block)
 * is cut on character count. Rare, but it must not produce one enormous chunk.
 */
function split(paragraph: Paragraph): Paragraph[] {
  if (paragraph.text.length <= TARGET_CHARS) return [paragraph];

  const pieces: Paragraph[] = [];
  for (let at = 0; at < paragraph.text.length; at += TARGET_CHARS) {
    pieces.push({
      text: paragraph.text.slice(at, at + TARGET_CHARS),
      start: paragraph.start + at,
      end: Math.min(paragraph.start + at + TARGET_CHARS, paragraph.end),
    });
  }
  return pieces;
}

export function chunkText(text: string): Chunk[] {
  const units = paragraphs(text).flatMap(split);
  if (units.length === 0) return [];

  const chunks: Chunk[] = [];
  let current: Paragraph[] = [];

  const flush = () => {
    if (current.length === 0) return;

    const start = current[0]!.start;
    const end = current[current.length - 1]!.end;
    chunks.push({
      index: chunks.length,
      content: text.slice(start, end).trim(),
      startOffset: start,
      endOffset: end,
    });

    // Carry the tail of this chunk into the next one, so a passage that
    // straddles a cut is still fully present in at least one chunk.
    const overlap: Paragraph[] = [];
    let carried = 0;
    for (let i = current.length - 1; i >= 0 && carried < OVERLAP_CHARS; i--) {
      overlap.unshift(current[i]!);
      carried += current[i]!.text.length;
    }
    // Never carry the whole chunk, or a long paragraph would loop forever.
    current = overlap.length < current.length ? overlap : [];
  };

  for (const unit of units) {
    const size = current.reduce((sum, p) => sum + p.text.length, 0);
    if (size > 0 && size + unit.text.length > TARGET_CHARS) flush();
    current.push(unit);
  }
  flush();

  return chunks;
}
