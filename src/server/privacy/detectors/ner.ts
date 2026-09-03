import type { TokenClassificationPipeline } from "@huggingface/transformers";

import { env } from "@/server/env";
import { logger } from "@/server/log/logger";
import { transformers } from "@/server/models";
import { dictionaryNames } from "@/server/privacy/detectors/dictionary";
import type { PersonDetector } from "@/server/privacy/detectors/types";

/**
 * Person detection by a NER model running in this process (CLAUDE.md §7).
 *
 * Measured against the seed corpus: 6/6 people, 10/10 occurrences, zero false
 * positives — against the heuristic detector's 50% precision. The larger
 * candidate, `bert-base-multilingual-cased-ner-hrl`, missed a Czech name and
 * was rejected; see docs/decisions.md. Neither model lists Czech among its ten
 * training languages, which is why the choice was measured rather than read
 * off a model card.
 *
 * Nothing leaves the process to be detected, the same property the local
 * embedder has: only the anonymised answer call crosses a network boundary.
 *
 * This file never logs what it finds. A model id and a load time are fine.
 */

/**
 * The model's window is 512 wordpieces and it TRUNCATES SILENTLY past it —
 * measured: a name beyond the boundary produces no PER tokens at all, and no
 * error. For a privacy control that is not a performance footnote, it is the
 * leak the control exists to prevent, arriving quietly. So text is windowed
 * here rather than handed over whole.
 *
 * The budget is the same pessimistic 3 characters per token that
 * src/server/rag/chunk.ts already justifies for the embedder, against a
 * measured 3.7 on this corpus.
 */
const MODEL_WINDOW_TOKENS = 512;
const CHARS_PER_TOKEN = 3;
export const WINDOW_CHARS = MODEL_WINDOW_TOKENS * CHARS_PER_TOKEN;

/**
 * Carried across a hard split, and only a hard split. Splitting between
 * paragraphs cannot cut a name in half; cutting an over-long paragraph can,
 * and neither half would be a name the anonymizer could find.
 *
 * The overlap protects names up to 64 characters. The longest person name in
 * the seed corpus is 24 characters; 64 is comfortably beyond any real name that
 * would fit in an anonymizer output or a typical text span.
 */
const SEAM_OVERLAP_CHARS = 64;

export interface TaggedToken {
  entity: string;
  word: string;
}

/** Text in pieces the model can actually see all of. */
export function windows(text: string): string[] {
  const out: string[] = [];
  let buffer = "";

  const flush = () => {
    if (buffer) out.push(buffer);
    buffer = "";
  };

  for (const paragraph of text.split(/\n\s*\n/)) {
    if (paragraph.length > WINDOW_CHARS) {
      flush();
      const step = WINDOW_CHARS - SEAM_OVERLAP_CHARS;
      for (let at = 0; at < paragraph.length; at += step) {
        out.push(paragraph.slice(at, at + WINDOW_CHARS));
      }
      continue;
    }

    if (buffer.length + paragraph.length + (buffer ? 2 : 0) > WINDOW_CHARS) flush();
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
  }

  flush();
  return out;
}

/**
 * Wordpieces back into surface strings.
 *
 * The pipeline gives no character offsets — output items carry `entity`,
 * `score`, a token `index` and a wordpiece `word` — so the only route back to
 * something the anonymizer can find is to stitch "Ho" + "##rá" + "##ková" and
 * check the result against the window it came from.
 */
export function personsIn(tokens: TaggedToken[], window: string): string[] {
  const found: string[] = [];
  let current: string | null = null;

  const flush = () => {
    // A stitched form the window does not contain is a reconstruction that
    // went wrong. The anonymizer would not find it either, so dropping it here
    // keeps that fact local instead of passing a phantom name outward. The
    // trim() check is the "##"-only-token defence: a continuation wordpiece
    // that carries no characters after the "##" marker (current starts as
    // null, so the first such token stitches to an empty string), and an
    // empty string is contained in every window, so window.includes alone
    // would push it through as a phantom name.
    if (current !== null && current.trim().length > 0 && window.includes(current)) found.push(current);
    current = null;
  };

  for (const token of tokens) {
    if (!token.entity.endsWith("PER")) {
      flush();
      continue;
    }

    if (token.word.startsWith("##")) {
      current = (current ?? "") + token.word.slice(2);
      continue;
    }

    if (token.entity.startsWith("B-")) flush();
    current = current === null ? token.word : `${current} ${token.word}`;
  }

  flush();
  return found;
}

let taggerPromise: Promise<TokenClassificationPipeline> | null = null;

function getTagger(): Promise<TokenClassificationPipeline> {
  if (taggerPromise) return taggerPromise;

  taggerPromise = (async () => {
    const { pipeline } = await transformers();

    const startedAt = Date.now();
    const tagger = await pipeline("token-classification", env.ANONYMIZER_MODEL, {
      // 8-bit weights: 129 MB in the image instead of 514 MB, and the measured
      // detection numbers above are the quantized ones.
      dtype: "q8",
    });

    logger.info(
      { model: env.ANONYMIZER_MODEL, loadMs: Date.now() - startedAt },
      "person detector model loaded",
    );
    return tagger;
  })();

  return taggerPromise;
}

export function createNerDetector(): PersonDetector {
  return {
    name: "ner",

    async detect(text: string): Promise<string[]> {
      // The dictionary is a certainty and costs nothing; the model replaces
      // the guessing, not the list.
      const found = new Set(dictionaryNames(text));

      const tagger = await getTagger();
      for (const window of windows(text)) {
        const tokens = (await tagger(window)) as TaggedToken[];
        for (const person of personsIn(tokens, window)) found.add(person);
      }

      return [...found];
    },

    async warmUp(): Promise<void> {
      await getTagger();
    },
  };
}
