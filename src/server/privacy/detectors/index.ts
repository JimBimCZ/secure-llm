import { env } from "@/server/env";
import { createHeuristicDetector } from "@/server/privacy/detectors/heuristic";
import { createNerDetector } from "@/server/privacy/detectors/ner";
import type { PersonDetector } from "@/server/privacy/detectors/types";

/**
 * The only place that decides which detector is in use. Everything else takes
 * the interface, so adding one is a new file plus an env value.
 *
 * Cached for the life of the process because the `ner` detector holds a loaded
 * model, the same reason `src/server/ai/index.ts` caches the embedder.
 *
 * There is deliberately NO fallback to `heuristic` when the model is missing.
 * A privacy control that quietly downgrades itself is worse than one that
 * stops the deployment — the same argument `src/server/env.ts` already makes
 * about refusing to start a keyless `anthropic` provider.
 */
let detector: PersonDetector | null = null;

export function getPersonDetector(): PersonDetector {
  if (detector) return detector;

  detector =
    env.ANONYMIZER_PROVIDER === "ner"
      ? createNerDetector()
      : createHeuristicDetector();

  return detector;
}
