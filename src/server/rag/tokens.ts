/**
 * What counts as a token worth searching for literally.
 *
 * Embeddings are good at meaning and bad at identifiers. `all-MiniLM-L6-v2`
 * puts "ddr5-6000" and "ddr5-5600" in almost the same place, because to a
 * sentence model they are the same kind of thing said about the same subject —
 * which is exactly wrong when the question is which of the two to buy. That is
 * the miss the lexical arm exists to catch, and nothing else.
 *
 * So this is not a keyword extractor. It answers one narrow question: does the
 * question contain something that looks like a part number? If it does not,
 * the lexical arm never runs and retrieval behaves exactly as it did before.
 * Two rules, both deliberately blunt:
 *
 * - A token must mix letters and digits. Prose does not: "supply" has no digit,
 *   and a bare "5600" is far more often a year, a price or a quantity than an
 *   identifier. Excluding bare numbers costs us "RTX 4090" written as two
 *   tokens — a real gap, in the README — and buys immunity to every question
 *   that happens to mention a number.
 * - A token must be at least three characters. "a1" and "b2" are DIMM slots in
 *   this corpus and would match half of it; "AM5" and "PL2" are the shortest
 *   identifiers that actually mean something.
 */

/** Letters, digits, and the separators that live INSIDE identifiers. */
const CANDIDATE = /[A-Za-z0-9][A-Za-z0-9_-]*/g;

const MIN_LENGTH = 3;

/**
 * The distinctive tokens in a question, lower-cased and de-duplicated.
 *
 * Order is the order they appear in the question, which only matters because
 * it makes the tests and the logs readable.
 */
export function distinctiveTokens(question: string): string[] {
  const found = new Set<string>();

  for (const [candidate] of question.matchAll(CANDIDATE)) {
    // A trailing separator is punctuation, not part of the identifier:
    // "ddr5-6000." arrives here as "ddr5-6000", but "ddr5-" arrives as "ddr5-".
    const token = candidate.replace(/[-_]+$/, "").toLowerCase();

    if (token.length < MIN_LENGTH) continue;
    if (!/[a-z]/.test(token)) continue;
    if (!/[0-9]/.test(token)) continue;

    found.add(token);
  }

  return [...found];
}
