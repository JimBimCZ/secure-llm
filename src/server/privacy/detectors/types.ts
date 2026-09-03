/**
 * Finds person names in a text (CLAUDE.md §7).
 *
 * It returns SURFACE STRINGS, not spans, and that is forced rather than
 * chosen: the NER pipeline this project uses exposes no character offsets —
 * its output carries wordpieces ("Ho", "##rá", "##ková") and a token index,
 * and its tokenizer does not support `return_offsets_mapping`. So a detector
 * reconstructs what it found and the anonymizer looks for it, which is what
 * the dictionary has always done.
 *
 * The failure direction that follows is the reassuring one: a string that is
 * not in the text replaces nothing, so a reconstruction that goes wrong is a
 * MISS, never a corruption.
 *
 * A detector must never log what it finds. A model id and a load time are
 * fine; a person's name in a log line is the leak this module exists to
 * prevent.
 */
export interface PersonDetector {
  readonly name: string;

  /** Person names present in `text`. Duplicates are allowed; the caller dedupes. */
  detect(text: string): Promise<string[]>;

  /**
   * Loads whatever the detector needs, so a broken configuration stops the
   * deployment at startup rather than failing every question.
   */
  warmUp(): Promise<void>;
}
