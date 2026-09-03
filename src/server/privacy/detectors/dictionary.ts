import { KNOWN_FULL_NAMES, KNOWN_SURNAMES } from "@/server/privacy/names";

/**
 * The half of person detection that is a certainty rather than a guess.
 *
 * Both detectors use it. A name the app has already been told about costs
 * nothing to match, is matched reliably in possessives and mid-sentence, and
 * covers the surname-alone case ("Dvořák's board") that no bigram rule and no
 * model is guaranteed to see. The model replaces the guessing, not the list.
 *
 * `names.ts` stays a plain list because its own docblock promises the list
 * comes from a directory export in a real deployment. This file is the lookup;
 * that file is the data.
 */
const DICTIONARY = [...KNOWN_FULL_NAMES, ...KNOWN_SURNAMES];

export function dictionaryNames(text: string): string[] {
  return DICTIONARY.filter((name) => text.includes(name));
}
