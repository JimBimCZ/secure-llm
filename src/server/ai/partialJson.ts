/**
 * Reads a JSON object that has not finished arriving.
 *
 * The streaming answer path needs two things out of a partial response: the
 * citation array as soon as it is complete, so the guard can run before any
 * prose is shown, and the prose so far, so it can be streamed. `JSON.parse`
 * gives neither until the last brace lands, which is exactly the wait this
 * slice exists to remove.
 *
 * It is deliberately a scanner and not a parser. It answers two questions
 * about a known shape rather than modelling JSON, and anything it cannot
 * answer yet it reports as "not yet" — never as a guess. A malformed response
 * must fail as a rejected answer somewhere that says so, never as a wrong
 * string read three files away.
 */

export interface PartialAnswer {
  /** Complete and well-formed, or null while it is still arriving. */
  citations: number[] | null;
  /** The decoded prefix of `answer`. Empty until the string opens. */
  answerSoFar: string;
}

const CITATIONS_KEY = '"citations"';
const ANSWER_KEY = '"answer"';

/** The single-character escapes JSON defines. `\u` is handled separately. */
const UNESCAPE: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

export function readPartial(accumulated: string): PartialAnswer {
  const start = accumulated.indexOf("{");
  if (start === -1) return { citations: null, answerSoFar: "" };

  const body = accumulated.slice(start);
  return { citations: readCitations(body), answerSoFar: readAnswer(body) };
}

/**
 * The offset of `key`'s value, but only when that value actually starts with
 * `delimiter`.
 *
 * Anchoring matters more here than it looks. A bare `indexOf` for the `[` or
 * the `"` will happily walk past a value of the wrong type and latch onto the
 * next one anywhere later in the buffer — which is how a response whose
 * `citations` is a string came back reporting a complete citation array that
 * appears nowhere in it. Returning -1 for a value that is not the shape the
 * contract promises keeps the "never a guess" rule this file opens with.
 */
function valueStart(body: string, key: string, delimiter: string): number {
  const at = body.indexOf(key);
  if (at === -1) return -1;

  let i = at + key.length;
  while (i < body.length && /\s/.test(body[i]!)) i += 1;
  if (body[i] !== ":") return -1;

  i += 1;
  while (i < body.length && /\s/.test(body[i]!)) i += 1;
  return body[i] === delimiter ? i : -1;
}

function readCitations(body: string): number[] | null {
  const open = valueStart(body, CITATIONS_KEY, "[");
  if (open === -1) return null;

  // No nesting to worry about: the contract says integers, so the first `]`
  // ends the array. A value that is not an integer list fails the check below
  // rather than being coerced into one.
  const close = body.indexOf("]", open);
  if (close === -1) return null;

  try {
    const parsed: unknown = JSON.parse(body.slice(open, close + 1));
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every((n) => Number.isInteger(n))) return null;
    return parsed as number[];
  } catch {
    return null;
  }
}

function readAnswer(body: string): string {
  const open = valueStart(body, ANSWER_KEY, '"');
  if (open === -1) return "";

  let out = "";
  for (let i = open + 1; i < body.length; i += 1) {
    const char = body[i]!;
    if (char === '"') break;
    if (char !== "\\") {
      out += char;
      continue;
    }

    const escaped = body[i + 1];
    // The backslash is the last thing to arrive: hold it rather than emit it.
    if (escaped === undefined) break;

    if (escaped === "u") {
      const hex = body.slice(i + 2, i + 6);
      if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 5;
      continue;
    }

    out += UNESCAPE[escaped] ?? escaped;
    i += 1;
  }

  return out;
}
