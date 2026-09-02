/**
 * The one notion of "significant word" shared by the two mock implementations
 * — the hashing embedder and the extractive answerer. Both are lexical
 * fallbacks, both need to ignore function words, and they must agree on what
 * counts as a term or the mock pipeline would rank on one basis and answer on
 * another.
 *
 * It is not a linguistic resource and does not pretend to be one. The real
 * providers never touch this file.
 */

/** Enough to stop function words dominating; deliberately short. */
const STOPWORDS = new Set(
  ("a an and are as at be but by can did do does done for from had has have how i if in into" +
    " is it its just me my no not of on or so than that the their then there these they this" +
    " to too was were what when where which who why will with would you your")
    .split(" "),
);

const MIN_TOKEN_LENGTH = 3;

/** Lower-cased alphanumeric terms worth keeping, with how often each appears. */
export function significantTerms(text: string): Map<string, number> {
  const counts = new Map<string, number>();

  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (token.length < MIN_TOKEN_LENGTH || STOPWORDS.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return counts;
}
