import { dictionaryNames } from "@/server/privacy/detectors/dictionary";
import type { PersonDetector } from "@/server/privacy/detectors/types";

/**
 * The detector this project shipped with: a name list and a guess.
 *
 * Measured against the seed corpus it finds every person — and six things that
 * are not people (`Arrow Lake`, `Curve Optimizer`, `Adaptive-Sync`, `Ultra
 * High`, `Display Stream`, `Wi-Fi`), for a person precision of 50%. Every real
 * name it found, the dictionary had already found, so the bigram's measured
 * contribution is the false positives alone.
 *
 * It is kept, and it is not dead code: it is what the tests use, because they
 * load no model, and it is what a build without the NER weights must be
 * configured to use. Its over-redaction was always the safe direction — a
 * redacted `Arrow Lake` is restored before the user sees it — so keeping it
 * costs nothing.
 *
 * BEHAVIOURAL DIVERGENCE from the pre-seam anonymizer: the old code ran the
 * dictionary over the whole text, then ran the bigram only over what the
 * dictionary had NOT already replaced with a placeholder — so "Jana Dvořák"
 * became "Jana [PERSON_1]", the dictionary catching just the surname. This
 * detector runs both passes over the same original text (the seam requires
 * that: a detector reasoning over another detector's placeholders is not a
 * thing this design allows), so the bigram sees "Jana Dvořák" whole and wins
 * on length, redacting the full span. This is deliberate, not a regression:
 * it is strictly more redaction, and over-redaction is the safe direction
 * this same docblock already argues for above.
 */

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

export function createHeuristicDetector(): PersonDetector {
  return {
    name: "heuristic",

    async detect(text: string): Promise<string[]> {
      const found = dictionaryNames(text);

      for (const match of text.matchAll(CAPITALISED_BIGRAM)) {
        const value = match[0];
        const first = value.split(/[\s\-']+/)[0] ?? "";
        // A sentence-starting word followed by a capital is far more often
        // prose than a person, and guessing wrong here is what makes a naive
        // detector look silly.
        if (SENTENCE_STARTERS.has(first)) continue;
        found.push(value);
      }

      return found;
    },

    /** Nothing to load. */
    async warmUp(): Promise<void> {},
  };
}
