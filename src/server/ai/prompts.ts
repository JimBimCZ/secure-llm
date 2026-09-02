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
 * The numbering here is the contract with the model: it cites [n], and
 * rag/answer.ts resolves n back to the chunk at that position. The two must
 * agree, so both derive from the same array order.
 */
function renderSources(chunks: AnswerInput["chunks"]): string {
  return chunks
    .map((chunk, i) => `[${i + 1}]\n${chunk.content}`)
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
    .replace("{{question}}", input.question)
    .replace("{{sources}}", renderSources(input.chunks));

  return { system, user };
}
