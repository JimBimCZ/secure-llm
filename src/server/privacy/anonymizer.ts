import type { PersonDetector } from "@/server/privacy/detectors/types";

/**
 * Replaces personal data with placeholders before text leaves the process, and
 * puts it back in what comes home (CLAUDE.md §7).
 *
 * It owns two things: the regexes for the values a regex genuinely settles —
 * e-mail addresses and phone numbers, measured at 6/6 and 3/3 with no false
 * positives — and the placeholder mapping. Deciding what is a PERSON is the
 * detector's job, behind `PersonDetector`, because that is the part where a
 * name list and a model disagree about how to work.
 *
 * ONE INSTANCE PER REQUEST. The mapping it accumulates is the only thing that
 * can turn "[PERSON_1]" back into a person, so it lives in memory for the life
 * of one request and is never persisted, never logged, and never returned to
 * the caller. Sharing an instance between requests would leak one user's names
 * into another user's restore step.
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

export type Category = "PERSON" | "EMAIL" | "PHONE";

export interface RedactionCounts {
  persons: number;
  emails: number;
  phones: number;
}

export interface Anonymizer {
  /** Personal data out, placeholders in. Safe to send onward. */
  redact(text: string): Promise<string>;
  /** Placeholders out, personal data back in. For the user's eyes only. */
  restore(text: string): string;
  /** How many DISTINCT values were replaced. Counts only — never the values. */
  counts(): RedactionCounts;
}

export function createAnonymizer(detector: PersonDetector): Anonymizer {
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

  return {
    async redact(text: string): Promise<string> {
      // Detection runs on the ORIGINAL text. Running it after the e-mail pass
      // would hand the detector placeholders to reason about.
      const detected = await detector.detect(text);

      // Longest first: "Horáková" is a substring of "Petra Horáková", and
      // replacing the short one first leaves "Petra [PERSON_2]" — a name half
      // redacted, and a placeholder standing for less than it appears to.
      const names = [...new Set(detected)].sort((a, b) => b.length - a.length);

      let out = text.replace(EMAIL, (m) => placeholderFor(m, "EMAIL"));
      out = out.replace(PHONE, (m) => placeholderFor(m, "PHONE"));

      for (const name of names) {
        // An empty or whitespace-only value is not merely useless: "".split()
        // matches between every character, so out.split(name).join(placeholder)
        // would insert a placeholder after every single character in the
        // text — total corruption, not a miss. A detector that stitches
        // wordpieces can produce one from a token that is exactly "##".
        if (!name.trim()) continue;
        // Not found means one of two harmless things: the value sat inside an
        // e-mail that is already a placeholder, or a detector reconstructed a
        // string that was never in the text. Either way it replaces nothing,
        // and it must not consume a placeholder number — `counts()` would then
        // report a redaction that never happened.
        if (!out.includes(name)) continue;
        out = out.split(name).join(placeholderFor(name, "PERSON"));
      }

      return out;
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
