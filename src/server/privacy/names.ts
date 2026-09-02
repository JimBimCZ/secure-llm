/**
 * The seed dictionary half of name detection (CLAUDE.md §7).
 *
 * These are the synthetic people who appear in `seed/`. A dictionary catches
 * the names you already know about — colleagues, family, a team roster — and
 * catches them reliably, including in possessives and mid-sentence, where the
 * capitalised-bigram heuristic is guessing.
 *
 * In a real deployment this list would come from wherever the organisation
 * already keeps its people (a directory export, an HR system), refreshed on a
 * schedule. It is a constant here because the corpus is synthetic and eight
 * names is the whole population. That substitution is the only change needed —
 * the anonymizer takes the list, it does not own it.
 *
 * Surnames are listed separately because notes refer to people by surname
 * alone ("Dvorak's board"), which no bigram rule can see.
 */
export const KNOWN_FULL_NAMES = [
  "Petra Horakova",
  "Petra Horáková",
  "Marek Dvorak",
  "Marek Dvořák",
  "David Kraus",
  "Radek Pokorny",
  "Radek Pokorný",
  "Lucie Simkova",
  "Lucie Šimková",
  "Tomas Bednar",
  "Tomáš Bednář",
] as const;

export const KNOWN_SURNAMES = [
  "Horakova",
  "Horáková",
  "Dvorak",
  "Dvořák",
  "Kraus",
  "Pokorny",
  "Pokorný",
  "Simkova",
  "Šimková",
  "Bednar",
  "Bednář",
] as const;
