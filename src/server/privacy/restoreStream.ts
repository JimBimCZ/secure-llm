/**
 * Applies the anonymizer's inverse mapping to text arriving in pieces.
 *
 * `Anonymizer.restore` works on complete text. Called once per streamed delta
 * it would corrupt any placeholder that straddles a boundary: `[PERSON_` and
 * `1]` restore to neither the placeholder nor the person, and the placeholder
 * syntax — which the user should never see — leaks into the answer.
 *
 * So this holds back the shortest suffix that could still become a
 * placeholder, and releases it the moment it either closes or becomes
 * impossible. It knows nothing about the mapping itself: `restore` arrives as
 * a parameter, so the per-request mapping stays where CLAUDE.md §7 puts it.
 */

/**
 * Longer than any placeholder this app produces — `[PERSON_999]` is 12 — so a
 * `[` in ordinary prose delays at most this many characters before the text
 * is released. Without the cap, a note containing "see [1]" would stall the
 * rest of the answer until the stream ended.
 */
const LONGEST_PLACEHOLDER = 16;

export interface Restorer {
  /** Restored text safe to show now. May be empty while a suffix is held. */
  push(delta: string): string;
  /** Whatever was still held when the stream ended. */
  flush(): string;
}

export function createRestorer(restore: (text: string) => string): Restorer {
  let held = "";

  return {
    push(delta: string): string {
      const text = held + delta;

      const open = text.lastIndexOf("[");
      const unterminated =
        open !== -1 &&
        !text.slice(open).includes("]") &&
        text.length - open <= LONGEST_PLACEHOLDER;

      const cut = unterminated ? open : text.length;
      held = text.slice(cut);

      return restore(text.slice(0, cut));
    },

    flush(): string {
      const rest = held;
      held = "";
      return restore(rest);
    },
  };
}
