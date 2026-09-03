/**
 * What counts as a term worth searching for literally.
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
 *
 * TWO SHAPES COUNT.
 *
 * 1. A token that mixes letters and digits, at least three characters long.
 *    Prose does not: "supply" has no digit, and a bare "5600" is far more often
 *    a year, a price or a quantity than an identifier. "a1" and "b2" are DIMM
 *    slots here and would match half the corpus; "AM5" and "PL2" are the
 *    shortest identifiers that mean anything.
 *
 * 2. A short word followed immediately by a number — "LGA 1718", "PCIe 5.0",
 *    "RTX 4090". Neither half qualifies under rule 1, and this is how a great
 *    many identifiers are actually written. Measured before this rule existed:
 *    "What did I write about LGA 1718?" was REFUSED, top score 0.236 against a
 *    0.25 floor, from a corpus that contains the answer.
 *
 * RULE 2 IS THE DANGEROUS ONE, because it admits a bare number, and the whole
 * case against bare numbers is that questions are full of them. Three
 * constraints keep it honest, and the third is the one that matters:
 *
 * - The word must be 2–5 letters and not a function word. Identifiers are
 *   short; "since 2023" and "under 1500" are not part numbers.
 * - The number must carry at least two digits, so "Ryzen 9" does not pair.
 *   A single digit after a word is more often a count than a designation.
 * - **The pair is searched for as a phrase** (see rag/retrieve.ts). "1718" is
 *   only ever looked for sitting immediately after "lga", in the question and
 *   in the chunk alike. Admitting a number bound to its word is a different
 *   thing from admitting numbers.
 *
 * Case is ignored, deliberately. People type "lga 1718" into a search box, and
 * a heuristic that needs the shift key is one that fails in front of an
 * audience.
 */

/**
 * Letters, digits, and the separators that live INSIDE identifiers. A dot only
 * counts between digits, so "PCIe 5.0" survives as one number while the full
 * stop ending a sentence does not join anything to it.
 */
const CANDIDATE = /[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[0-9]+)*/g;

const MIN_LENGTH = 3;

/** The longest a word can be and still plausibly be a designation. */
const MAX_NAME_LENGTH = 5;

/**
 * Short function words that make a following number prose rather than a part
 * number. Deliberately tiny, and specific to this one rule: it only has to
 * cover words that plausibly sit immediately before a number in a question.
 * (`ai/lexical.ts` has a stopword list too, for the mock providers. They are
 * separate on purpose — this one is on the real retrieval path and answers a
 * different question.)
 */
const FUNCTION_WORDS = new Set(
  ("a also an and are as at be both but by did do each for from had has have in into" +
    " is it its just last least less many more most much my near next no not of on" +
    " only or over past per said says since so some such than that the their them then" +
    " these they this those to too under until up very was were what when with your" +
    " about after")
    .split(" "),
);

/** Rule 1: mixes letters and digits, long enough to be distinctive. */
function isIdentifier(token: string): boolean {
  return (
    token.length >= MIN_LENGTH && /[a-z]/.test(token) && /[0-9]/.test(token)
  );
}

/** The first half of rule 2: a short word carrying no digits of its own. */
function isDesignationWord(token: string): boolean {
  return (
    token.length >= 2 &&
    token.length <= MAX_NAME_LENGTH &&
    /^[a-z]+$/.test(token) &&
    !FUNCTION_WORDS.has(token)
  );
}

/** The second half of rule 2: a number, and not a single digit. */
function isDesignationNumber(token: string): boolean {
  return /^[0-9][0-9.]*$/.test(token) && (token.match(/[0-9]/g) ?? []).length >= 2;
}

/**
 * The distinctive terms in a question, lower-cased and de-duplicated. A term is
 * one token ("ddr5-6000") or two words that belong together ("lga 1718").
 *
 * Order is the order they appear in the question, which only matters because
 * it makes the tests and the logs readable.
 */
export function distinctiveTerms(question: string): string[] {
  const terms = new Set<string>();
  let previous: { token: string; end: number } | null = null;

  for (const match of question.matchAll(CANDIDATE)) {
    // A trailing separator is punctuation, not part of the identifier:
    // "ddr5-6000." arrives here as "ddr5-6000", but "ddr5-" arrives as "ddr5-".
    const token = match[0].replace(/[-_]+$/, "").toLowerCase();
    const start = match.index;

    // Nothing but spaces may separate the two halves. Adjacency is the whole
    // evidence that they are one identifier rather than two coincidences.
    const adjacent =
      previous !== null && /^ +$/.test(question.slice(previous.end, start));

    if (
      adjacent &&
      isDesignationWord(previous!.token) &&
      isDesignationNumber(token)
    ) {
      terms.add(`${previous!.token} ${token}`);
    }

    if (isIdentifier(token)) terms.add(token);

    previous = { token, end: start + match[0].length };
  }

  return [...terms];
}
