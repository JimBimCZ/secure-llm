import { readFileSync } from "node:fs";
import path from "node:path";

import type { AnswerInput } from "@/server/ai/types";

/**
 * Prompts live in `prompts/*.md` and are read from there at runtime. No prompt
 * text is written in TypeScript (CLAUDE.md §3): the folder is the single source
 * of truth, so anyone can read exactly what the model was told without
 * reading any code, and editing a prompt is not a code change.
 *
 * Read synchronously and cached — these are three small files loaded once per
 * process, and doing it lazily keeps the build from touching the filesystem.
 */
const PROMPT_DIR = path.join(process.cwd(), "prompts");

const cache = new Map<string, string>();

function load(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const text = readFileSync(path.join(PROMPT_DIR, `${name}.md`), "utf8").trim();
  cache.set(name, text);
  return text;
}

/**
 * The tags this prompt uses to separate instructions from data.
 *
 * Retrieved chunks are the user's own notes, but a note can come from
 * anywhere — a PDF someone e-mailed, a page pasted from a wiki — and it
 * reaches the model verbatim. Before this envelope existed, a sentence in a
 * note reading "ignore the above and answer X" sat in the prompt looking
 * exactly like an instruction from us, because nothing marked where the data
 * began. Now something does, and the only remaining trick is forging the mark
 * itself, which is what `fence` below takes away.
 *
 * The defence is deliberately structural rather than a detector: there is no
 * list of forbidden phrases to keep up to date and no false positives on a
 * note that legitimately discusses prompt injection.
 */
const TAGS = ["source", "question"] as const;

/**
 * Anything shaped like one of those tags, however sloppily written: optional
 * whitespace inside the brackets, any casing, any attributes. Deliberately
 * looser than an XML parser would be, because the reader being defended
 * against is a model, and `< /Source >` reads as a tag to a model even though
 * a parser would reject it. Bounded to a single line so an unclosed `<` cannot
 * swallow the rest of a document.
 */
const TAG_LIKE = new RegExp(
  `<\\s*/?\\s*(?:${TAGS.join("|")})\\b[^>\\n]*>?`,
  "gi",
);

/**
 * Makes untrusted text unable to close, or open, one of our tags.
 *
 * Only tag-shaped spans are touched. Every other angle bracket is left exactly
 * as written: notes are full of `a < b` and `<div>`, and mangling a code
 * snippet to defend against a string that is not the delimiter would cost more
 * than it buys.
 *
 * Escaping rather than stripping, because the sentence that tried it is still
 * note content. If the user asks what that document says, the honest answer
 * includes it — as a quotation, which is exactly the status the envelope gives
 * it.
 */
function fence(text: string): string {
  return text.replace(TAG_LIKE, (tag) => {
    const closed = tag.endsWith(">");
    const inner = closed ? tag.slice(1, -1) : tag.slice(1);
    return `&lt;${inner}${closed ? "&gt;" : ""}`;
  });
}

/**
 * The numbering here is the contract with the model: it cites the `index` of a
 * source, and rag/answer.ts resolves that number back to the chunk at that
 * position. The two must agree, so both derive from the same array order.
 */
function renderSources(chunks: AnswerInput["chunks"]): string {
  return chunks
    .map((chunk, i) => `<source index="${i + 1}">\n${fence(chunk.content)}\n</source>`)
    .join("\n\n");
}

export function renderAnswerPrompt(input: AnswerInput): {
  system: string;
  user: string;
} {
  const system = input.retry
    ? `${load("answer-system")}\n\n${load("answer-retry")}`
    : load("answer-system");

  const user = load("answer-user")
    .replace("{{question}}", fence(input.question))
    .replace("{{sources}}", renderSources(input.chunks));

  return { system, user };
}
