import { KNOWN_FULL_NAMES, KNOWN_SURNAMES } from "@/server/privacy/names";

/**
 * Replaces personal data with placeholders before text leaves the process, and
 * puts it back in what comes home (CLAUDE.md §7).
 *
 * Deliberately simple and explainable. It is regexes and a name list, and it is
 * meant to be read in one sitting and argued with. A naive detector whose
 * limits are written down beats a black box whose limits are not — the limits
 * are in the README, and the measured false-positive rate is in
 * docs/decisions.md.
 *
 * ONE INSTANCE PER REQUEST. The mapping it accumulates is the only thing that
 * can turn "[PERSON_1]" back into a person, so it lives in memory for the life
 * of one request and is never persisted, never logged, and never returned to
 * the caller. Sharing an instance between requests would leak one user's names
 * into another user's restore step.
 *
 * Known limits, all of them deliberate:
 * - The bigram heuristic cannot tell a person from a two-word proper noun, so
 *   "Arrow Lake" is redacted as a person. That direction of error is the safe
 *   one: the model reasons over an opaque token and `restore` puts the real
 *   text back, so the user still reads "Arrow Lake".
 * - A single unknown first name on its own ("ask Petra") is missed unless the
 *   name is in the dictionary.
 * - Addresses, dates of birth and account numbers are not detected at all.
 */

/** Order matters: an e-mail contains a name, so e-mails go first. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Requires either an international prefix or separated 3-3-3/4 grouping.
 * Written tightly on purpose: these notes are full of numbers ("3200 MHz",
 * "600 TBW", "100 µs"), and a loose phone pattern would redact the technical
 * content the answer depends on.
 */
const PHONE = /(?:\+\d{1,3}[ -]?)?\d{3}[ -]\d{3}[ -]\d{3,4}\b|\+\d{9,15}\b/g;

/**
 * Two capitalised words in a row. Unicode-aware, because the corpus is Czech
 * and \w would cut "Horáková" in half at the á.
 *
 * The separator is same-line whitespace or a hyphen, never `\s+`. With `\s+`
 * the pattern jumped a blank line and joined a heading to the paragraph under
 * it — "Undervolting\n\nSame" and "Endurance\n\nRated" were both redacted as
 * people. A person's two names are not separated by a paragraph break.
 */
const CAPITALISED_BIGRAM = /\p{Lu}\p{Ll}+(?:[ \t]+|[-'])\p{Lu}\p{Ll}+/gu;

/**
 * Words that start sentences and are followed by another capital often enough
 * to matter. Cheap, and it removed most of the heuristic's false positives on
 * the seed corpus without touching a single real name.
 */
const SENTENCE_STARTERS = new Set([
  "A", "After", "All", "An", "And", "As", "At", "Because", "Before", "Both",
  "But", "By", "Do", "Every", "For", "From", "How", "If", "In", "It", "Its",
  "My", "No", "None", "Not", "On", "One", "Only", "Or", "Since", "So", "That",
  "The", "Their", "Then", "There", "These", "This", "Those", "To", "Two",
  "What", "When", "Where", "Which", "Who", "Why", "With", "Without",
]);

export type Category = "PERSON" | "EMAIL" | "PHONE";

export interface RedactionCounts {
  persons: number;
  emails: number;
  phones: number;
}

export interface Anonymizer {
  /** Personal data out, placeholders in. Safe to send onward. */
  redact(text: string): string;
  /** Placeholders out, personal data back in. For the user's eyes only. */
  restore(text: string): string;
  /** How many DISTINCT values were replaced. Counts only — never the values. */
  counts(): RedactionCounts;
}

export function createAnonymizer(): Anonymizer {
  // original -> placeholder, so the same person gets the same number across the
  // question and every chunk in one request.
  const placeholders = new Map<string, string>();
  // placeholder -> original, for the way back.
  const originals = new Map<string, string>();
  const nextIndex: Record<Category, number> = { PERSON: 0, EMAIL: 0, PHONE: 0 };

  function placeholderFor(value: string, category: Category): string {
    const existing = placeholders.get(value);
    if (existing) return existing;

    nextIndex[category] += 1;
    const placeholder = `[${category}_${nextIndex[category]}]`;
    placeholders.set(value, placeholder);
    originals.set(placeholder, value);
    return placeholder;
  }

  /** Longest first, so "Petra Horáková" is matched before "Horáková". */
  const dictionary = [...KNOWN_FULL_NAMES, ...KNOWN_SURNAMES].sort(
    (a, b) => b.length - a.length,
  );

  return {
    redact(text: string): string {
      let out = text.replace(EMAIL, (m) => placeholderFor(m, "EMAIL"));
      out = out.replace(PHONE, (m) => placeholderFor(m, "PHONE"));

      // The dictionary runs before the heuristic: a known name is a certainty,
      // and matching it first means the heuristic never gets to guess at it.
      for (const name of dictionary) {
        if (!out.includes(name)) continue;
        out = out.split(name).join(placeholderFor(name, "PERSON"));
      }

      return out.replace(CAPITALISED_BIGRAM, (match) => {
        const first = match.split(/[\s\-']+/)[0] ?? "";
        // A sentence-starting word followed by a capital is far more often
        // prose than a person, and guessing wrong here is what makes a naive
        // detector look silly.
        if (SENTENCE_STARTERS.has(first)) return match;
        return placeholderFor(match, "PERSON");
      });
    },

    restore(text: string): string {
      let out = text;
      for (const [placeholder, original] of originals) {
        // split/join, not a regex: the placeholder contains [ and ], which are
        // regex metacharacters, and escaping them by hand is a bug waiting.
        out = out.split(placeholder).join(original);
      }
      return out;
    },

    counts(): RedactionCounts {
      return {
        persons: nextIndex.PERSON,
        emails: nextIndex.EMAIL,
        phones: nextIndex.PHONE,
      };
    },
  };
}
