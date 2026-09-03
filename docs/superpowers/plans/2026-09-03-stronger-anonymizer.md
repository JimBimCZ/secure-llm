# Stronger Anonymizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the capitalised-bigram guess with an in-process NER model behind a new `PersonDetector` seam, taking person precision from a measured 50% to a measured 100% without changing a call site.

**Architecture:** A `PersonDetector` returns the **surface strings** in a text that are person names; the anonymizer keeps everything else it does today — e-mail and phone regexes, placeholder allocation, the one-instance-per-request mapping, `restore`, `counts` — and replaces those strings longest-first. Two implementations: `heuristic` (today's dictionary + bigram, moved verbatim, used by the tests) and `ner` (dictionary + `Xenova/distilbert-base-multilingual-cased-ner-hrl`, in-process, windowed against a model that truncates silently). Strings rather than spans is forced: the pipeline exposes no character offsets.

**Tech Stack:** TypeScript, Next.js 16 App Router, `@huggingface/transformers` 4.2.0 with ONNX q8 weights, zod 4, pino, `node --test` with type stripping.

**Spec:** `docs/superpowers/specs/2026-09-03-stronger-anonymizer-design.md`

## Global Constraints

- **The test suite loads no model and opens no database connection.** `test/env.ts` is what keeps that true. A test that loads a model is slow, needs the image's baked weights, and can pass for the wrong reason. Task 4 adds `ANONYMIZER_PROVIDER: "heuristic"` there; until then the tests construct detectors explicitly.
- **No new dependencies.** `@huggingface/transformers` is already a dependency; nothing else is added. CLAUDE.md §8.
- **A new env var goes in five places** or it silently does nothing: `src/server/env.ts` zod schema, `src/server/env.ts` `BUILD_PHASE_PLACEHOLDERS`, `.env.example`, `docker-compose.yaml`, `README.md` configuration table.
- **Do not touch `.env`.** CLAUDE.md §8. The rename in Task 1 is safe for an existing local `.env`: `withoutBlanks` treats an unset variable as absent and `MODEL_CACHE_DIR` falls back to `./.models`. Say so in the README rather than editing anyone's file.
- **Env var names, defaults and values, verbatim:**
  - `ANONYMIZER_PROVIDER`, `z.enum(["ner", "heuristic"])`, `.default("ner")`
  - `ANONYMIZER_MODEL`, `z.string().min(1)`, `.default("Xenova/distilbert-base-multilingual-cased-ner-hrl")`
  - `MODEL_CACHE_DIR`, `z.string().min(1)`, `.default("./.models")` — renamed from `EMBEDDING_CACHE_DIR`
- **Never log a detected value.** The detector may log a model id and a load time. A person's name in a log line is the leak the whole module exists to prevent.
- **Every non-trivial decision gets a line in `docs/decisions.md`** in the form `YYYY-MM-DD — <decision> — <why> — <what was rejected>`. Today is `2026-09-03`.
- **Commands:** `npm test`, `npm run typecheck`.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/server/models.ts` | The one place that configures `@huggingface/transformers` for this process | 1 |
| `src/server/ai/embedders/local.ts` | Stops configuring the library itself; calls the shared module | 1 |
| `src/server/env.ts`, `.env.example`, `docker-compose.yaml`, `scripts/fetch-model.mjs` | `EMBEDDING_CACHE_DIR` → `MODEL_CACHE_DIR` | 1 |
| `src/server/privacy/detectors/types.ts` | `PersonDetector` — the seam, and nothing else | 2 |
| `src/server/privacy/detectors/dictionary.ts` | `dictionaryNames`, shared by both detectors | 2 |
| `src/server/privacy/detectors/heuristic.ts` | Today's bigram + sentence-starter list, moved | 2 |
| `src/server/privacy/anonymizer.ts` | Takes a detector; `redact` becomes async; replaces longest-first | 2 |
| `src/server/rag/answer.ts` | Awaits `redact` for the question and each chunk | 2 |
| `test/anonymizer.test.ts` | Existing cases re-pointed, plus the stub-detector cases | 2 |
| `src/server/privacy/detectors/ner.ts` | The model, the 1,536-character window, the wordpiece stitching | 3 |
| `test/ner-detector.test.ts` | `windows` and `personsIn` — pure, model-free | 3 |
| `src/server/privacy/detectors/index.ts` | `getPersonDetector()`, cached for the process | 4 |
| `src/server/env.ts`, `.env.example`, `docker-compose.yaml`, `test/env.ts` | The two new variables | 4 |
| `scripts/fetch-models.mjs`, `Dockerfile` | Both models baked at build time | 4 |
| `src/instrumentation.node.ts` | Eager load, so a broken model stops startup | 4 |
| `README.md`, `docs/decisions.md`, `CLAUDE.md` | The measured table, the gaps, the decisions | 6 |

---

### Task 1: One place that configures the model runtime

**Files:**
- Create: `src/server/models.ts`
- Modify: `src/server/ai/embedders/local.ts:1-45`
- Modify: `src/server/env.ts:36` and `src/server/env.ts:124`
- Modify: `.env.example:85-91`
- Modify: `docker-compose.yaml:72`
- Modify: `scripts/fetch-model.mjs:13`
- Modify: `README.md` configuration table row, `docs/implementation-plan.md:126`

**Interfaces:**
- Consumes: nothing.
- Produces: `transformers(): Promise<typeof import("@huggingface/transformers")>` from `@/server/models`, already configured; `env.MODEL_CACHE_DIR: string`.

**Why this is its own task:** `@huggingface/transformers` exposes `env.cacheDir`, `env.localModelPath` and `env.allowRemoteModels` as **process-global** settings. Today one loader sets them. From Task 3 there are two, and two callers setting global state independently means the second silently reconfigures the first. Nothing in this task changes behaviour, which is what makes it reviewable on its own.

- [ ] **Step 1: Create the shared module**

Create `src/server/models.ts`:

```ts
import { env } from "@/server/env";

/**
 * The one place that configures `@huggingface/transformers` for this process.
 *
 * `cacheDir`, `localModelPath` and `allowRemoteModels` are PROCESS-GLOBAL in
 * that library, and two models now depend on them: the embedder (CLAUDE.md §5)
 * and the person detector (§7). Two callers setting them independently would
 * mean whichever loaded second silently reconfigured the first, which is the
 * kind of bug that only shows up as a model quietly loading from the wrong
 * place. So they are set here, once, and both loaders come through here.
 *
 * `allowRemoteModels = false` is the promise that the container never reaches
 * the Hugging Face Hub: every model is baked into the image at build time, so
 * `docker compose up` works with no network and cannot fail on a third party's
 * uptime. A missing model must fail loudly rather than be fetched.
 */
let configured: Promise<typeof import("@huggingface/transformers")> | null = null;

export function transformers(): Promise<typeof import("@huggingface/transformers")> {
  if (configured) return configured;

  configured = (async () => {
    const module = await import("@huggingface/transformers");

    module.env.cacheDir = env.MODEL_CACHE_DIR;
    module.env.localModelPath = env.MODEL_CACHE_DIR;
    module.env.allowRemoteModels = false;

    return module;
  })();

  return configured;
}
```

- [ ] **Step 2: Point the embedder at it**

In `src/server/ai/embedders/local.ts`, replace the import block and the body of `getPipeline`'s configuration. The file currently opens:

```ts
import type { FeatureExtractionPipeline } from "@huggingface/transformers";

import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from "@/server/ai/types";
import { env } from "@/server/env";
import { logger } from "@/server/log/logger";
```

Add one import:

```ts
import { transformers } from "@/server/models";
```

Then replace these five lines inside `getPipeline`:

```ts
    const { pipeline, env: hfEnv } = await import("@huggingface/transformers");

    hfEnv.cacheDir = env.EMBEDDING_CACHE_DIR;
    hfEnv.localModelPath = env.EMBEDDING_CACHE_DIR;
    // If the model is missing, fail loudly at startup rather than silently
    // reaching out to the internet from a container that should not have any.
    hfEnv.allowRemoteModels = false;
```

with:

```ts
    // Configured in one place, because those settings are process-global and
    // the person detector loads a second model through the same library.
    const { pipeline } = await transformers();
```

Leave the rest of the file — the `dtype: "q8"` comment, the load log, the dimension check — exactly as it is.

- [ ] **Step 3: Rename the variable in the env schema**

In `src/server/env.ts`, remove `EMBEDDING_CACHE_DIR` from the Embeddings block (line 36) and add a new block immediately **above** `// --- Embeddings ---`:

```ts
  // --- Local models ---------------------------------------------------
  // Where the models baked into the image at build time live. One directory
  // for both of them — the embedder and the person detector — because
  // `@huggingface/transformers` reads this as process-global state and cannot
  // hold two. See src/server/models.ts.
  MODEL_CACHE_DIR: z.string().min(1).default("./.models"),

```

- [ ] **Step 4: Rename it in the build-phase placeholders**

In `BUILD_PHASE_PLACEHOLDERS`, replace:

```ts
  EMBEDDING_CACHE_DIR: "./.models",
```

with:

```ts
  MODEL_CACHE_DIR: "./.models",
```

- [ ] **Step 5: Rename it in `.env.example`**

Replace lines 85–91 of `.env.example`:

```
# --- Local models -------------------------------------------------------
# Where the models baked into the image at build time live. One directory for
# both the embedder and the person detector: @huggingface/transformers reads
# this as process-global state and cannot hold two.
# Renamed from EMBEDDING_CACHE_DIR — an .env still carrying the old name is
# harmless, the new one simply falls back to this default.
MODEL_CACHE_DIR=./.models

# --- Embeddings ---------------------------------------------------------
# local = model runs in-process, no text leaves the app to be embedded.
# mock  = deterministic hashing, no model. Retrieval degrades to keyword
#         matching, which is what makes the app demoable with no model present.
EMBEDDING_PROVIDER=local
EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
```

- [ ] **Step 6: Rename it in the compose file**

In `docker-compose.yaml`, replace `      EMBEDDING_CACHE_DIR: ${EMBEDDING_CACHE_DIR}` with:

```yaml
      MODEL_CACHE_DIR: ${MODEL_CACHE_DIR}
```

Move it to sit directly above `EMBEDDING_PROVIDER: ${EMBEDDING_PROVIDER}`, so the file reads in the same order as `.env.example`.

- [ ] **Step 7: Rename it in the fetch script**

In `scripts/fetch-model.mjs`, replace:

```js
const cacheDir = process.env.EMBEDDING_CACHE_DIR ?? "./.models";
```

with:

```js
const cacheDir = process.env.MODEL_CACHE_DIR ?? "./.models";
```

- [ ] **Step 8: Rename it in the two documents that name it**

In `README.md`, the configuration table row `| \`EMBEDDING_CACHE_DIR\` | \`./.models\` | Where the baked-in model lives |` becomes:

```
| `MODEL_CACHE_DIR` | `./.models` | Where the baked-in models live — both of them |
```

In `docs/implementation-plan.md:126`, the deviation note reads `and \`LLM_TIMEOUT_MS\` and \`EMBEDDING_CACHE_DIR\` were added`. Change `EMBEDDING_CACHE_DIR` to `MODEL_CACHE_DIR` and append one sentence: `(\`EMBEDDING_CACHE_DIR\` was its name until slice 16 put a second model in the process.)`

- [ ] **Step 9: Verify nothing broke**

Run: `npm run typecheck && npm test`
Expected: typecheck clean, all tests pass. No behaviour changed, so any failure here is a mistake in the rename.

Then prove the old name is gone:

Run: `grep -rn "EMBEDDING_CACHE_DIR" --include="*.ts" --include="*.mjs" --include="*.yaml" --include="*.example" --include="*.md" . | grep -v node_modules | grep -v "^./.next"`
Expected: only the historical mention you added in `docs/implementation-plan.md`.

- [ ] **Step 10: Commit**

```bash
git add src/server/models.ts src/server/ai/embedders/local.ts src/server/env.ts .env.example docker-compose.yaml scripts/fetch-model.mjs README.md docs/implementation-plan.md
git commit -m "refactor(models): configure the transformers runtime in one place

Its cacheDir, localModelPath and allowRemoteModels are process-global, and
slice 16 puts a second model in the process. Two callers setting global
state independently means the second silently reconfigures the first.

EMBEDDING_CACHE_DIR becomes MODEL_CACHE_DIR for the same reason: the
directory was never per-model. An .env still carrying the old name falls
back to the same default.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TDX8fgBaSkSM5MaDDXV9Mq"
```

---

### Task 2: The seam, and today's detector behind it

**Files:**
- Create: `src/server/privacy/detectors/types.ts`, `src/server/privacy/detectors/dictionary.ts`, `src/server/privacy/detectors/heuristic.ts`
- Modify: `src/server/privacy/anonymizer.ts` (whole file)
- Modify: `src/server/rag/answer.ts:127-135`
- Modify: `test/anonymizer.test.ts` (whole file)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `PersonDetector` (`{ readonly name: string; detect(text: string): Promise<string[]>; warmUp(): Promise<void> }`), `dictionaryNames(text: string): string[]`, `createHeuristicDetector(): PersonDetector`, and `createAnonymizer(detector: PersonDetector): Anonymizer` whose `redact(text: string): Promise<string>` is now async. `restore` and `counts` are unchanged and stay synchronous.

**The deliverable is a refactor with no behaviour change.** Every existing test stays and passes; that is the proof.

- [ ] **Step 1: Write the seam**

Create `src/server/privacy/detectors/types.ts`:

```ts
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
```

- [ ] **Step 2: Move the dictionary lookup out**

Create `src/server/privacy/detectors/dictionary.ts`:

```ts
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
```

Note there is no sort here. Ordering is the anonymizer's problem now, because it applies to every detector's output and not just this one — Step 4.

- [ ] **Step 3: Move today's heuristic out**

Create `src/server/privacy/detectors/heuristic.ts`, moving `CAPITALISED_BIGRAM` and `SENTENCE_STARTERS` out of `anonymizer.ts` unchanged:

```ts
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
 * load no model, and it is what a build without the NER weights runs. Its
 * over-redaction was always the safe direction — a redacted `Arrow Lake` is
 * restored before the user sees it — so keeping it costs nothing.
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
```

- [ ] **Step 4: Rewrite the anonymizer around the detector**

Replace `src/server/privacy/anonymizer.ts` entirely:

```ts
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
```

- [ ] **Step 5: Await it at the one call site**

In `src/server/rag/answer.ts`, add the import:

```ts
import { createHeuristicDetector } from "@/server/privacy/detectors/heuristic";
```

Then replace lines 127–135:

```ts
  const anonymizer = createAnonymizer();
  const redactedQuestion = anonymizer.redact(question);
  const input = {
    question: redactedQuestion,
    chunks: retrieved.map((c) => ({
      id: c.id,
      documentId: c.documentId,
      content: anonymizer.redact(c.content),
    })),
  };
```

with:

```ts
  const anonymizer = createAnonymizer(createHeuristicDetector());
  const redactedQuestion = await anonymizer.redact(question);
  // Sequential, and measured: batching the chunks into one model call was
  // slower than this, because the pipeline pads every input to the longest.
  const chunks: AnswerInput["chunks"] = [];
  for (const chunk of retrieved) {
    chunks.push({
      id: chunk.id,
      documentId: chunk.documentId,
      content: await anonymizer.redact(chunk.content),
    });
  }
  const input = { question: redactedQuestion, chunks };
```

`AnswerInput` is already imported as a type at `answer.ts:3`, so the annotation costs no new import. It is annotated rather than inferred because an unannotated `[]` is an evolving `any[]`, which this project's `strict` settings may reject.

Task 4 replaces `createHeuristicDetector()` with the factory. It is written out here so this task leaves the app working and its behaviour identical.

- [ ] **Step 6: Re-point the existing tests, and run them**

In `test/anonymizer.test.ts`, add the import:

```ts
import { createHeuristicDetector } from "@/server/privacy/detectors/heuristic";
```

Then, in every existing test: change `createAnonymizer()` to `createAnonymizer(createHeuristicDetector())`, make each `it` callback `async`, and `await` every `a.redact(...)` / `b.redact(...)` call. `restore` and `counts` stay synchronous.

Two of the existing cases need care because they assert on a redacted value inline:

```ts
  it("leaves text with nothing personal in it untouched", async () => {
    const a = createAnonymizer(createHeuristicDetector());
    const plain = "A 1 TB consumer TLC drive is rated around 600 TBW.";

    assert.equal(await a.redact(plain), plain);
    assert.deepEqual(a.counts(), { persons: 0, emails: 0, phones: 0 });
  });

  it("does not mistake technical figures for phone numbers", async () => {
    const a = createAnonymizer(createHeuristicDetector());
    const redacted = await a.redact("Runs at 3200 MHz, rated 600 TBW, 100 µs spike.");

    assert.equal(a.counts().phones, 0);
    assert.equal(redacted, "Runs at 3200 MHz, rated 600 TBW, 100 µs spike.");
  });
```

Run: `npm test -- --test-name-pattern="anonymizer"`
Expected: every existing case passes unchanged in substance. A failure here means the refactor changed behaviour, which it must not.

- [ ] **Step 7: Add the stub-detector cases**

Append to `test/anonymizer.test.ts`, inside the `describe("anonymizer", ...)` block:

```ts
  /**
   * A detector that reports exactly what it is told to. It is how the
   * anonymizer's own behaviour gets tested without loading a model — and it is
   * the only way to reach the cases a real detector reaches only by accident.
   */
  const stub = (...values: string[]): PersonDetector => ({
    name: "stub",
    async detect() {
      return values;
    },
    async warmUp() {},
  });

  it("replaces exactly what the detector reports, and nothing else", async () => {
    const a = createAnonymizer(stub("Arrow Lake"));

    const redacted = await a.redact("The Arrow Lake chip beat the Raptor Lake chip.");

    assert.equal(redacted, "The [PERSON_1] chip beat the Raptor Lake chip.");
    assert.equal(a.counts().persons, 1);
  });

  it("does nothing with a value that is not in the text", async () => {
    // The reconstruction-miss direction. A detector that stitches wordpieces
    // can produce a string the text never contained — the rejected NER model
    // produced "Poný" from "Radek Pokorný" — and the result must be a miss,
    // never a corruption, and never a counted redaction.
    const a = createAnonymizer(stub("Poný"));
    const text = "Radek Pokorný tuned the fan curve.";

    assert.equal(await a.redact(text), text);
    assert.equal(a.counts().persons, 0);
  });

  it("replaces the longest reported value first", async () => {
    // "Horáková" is a substring of "Petra Horáková". Shortest-first would
    // leave "Petra [PERSON_1]" — half a name, still readable as a person.
    const a = createAnonymizer(stub("Horáková", "Petra Horáková"));

    const redacted = await a.redact("Petra Horáková said so, and Horáková was right.");

    assert.equal(redacted, "[PERSON_1] said so, and [PERSON_2] was right.");
    assert.equal(a.restore(redacted), "Petra Horáková said so, and Horáková was right.");
  });

  it("still redacts an e-mail before a name found inside it", async () => {
    const a = createAnonymizer(stub("Dvorak"));

    const redacted = await a.redact("Write to marek.Dvorak@example.com today.");

    assert.equal(redacted, "Write to [EMAIL_1] today.");
    assert.equal(a.counts().persons, 0);
    assert.equal(a.counts().emails, 1);
  });

  it("numbers one detected value identically across separate redact calls", async () => {
    const a = createAnonymizer(stub("Tomáš Bednář"));

    const question = await a.redact("What did Tomáš Bednář measure?");
    const chunk = await a.redact("Tomáš Bednář measured the fan curve.");

    assert.match(question, /\[PERSON_1\]/);
    assert.match(chunk, /\[PERSON_1\]/);
    assert.equal(a.counts().persons, 1);
  });
```

Add the type import at the top of the file:

```ts
import type { PersonDetector } from "@/server/privacy/detectors/types";
```

- [ ] **Step 8: Run the tests**

Run: `npm test`
Expected: all pass, including `test/answer.test.ts`, which exercises `askQuestion` and therefore the async `redact`.

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/server/privacy src/server/rag/answer.ts test/anonymizer.test.ts
git commit -m "refactor(privacy): give the anonymizer a detector to ask

The README said the seam was already there. It was not: createAnonymizer()
took no argument and had one implementation. This builds it, and moves
today's dictionary-and-bigram detector behind it unchanged — the existing
tests passing untouched in substance is the proof.

A detector returns surface strings rather than spans because the NER
pipeline of the next commit exposes no character offsets. The anonymizer
replaces them longest-first, so 'Horáková' cannot half-redact 'Petra
Horáková', and skips a value it cannot find, so a reconstruction that goes
wrong is a miss rather than a corruption or a miscount.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TDX8fgBaSkSM5MaDDXV9Mq"
```

---

### Task 3: The NER detector

**Files:**
- Create: `src/server/privacy/detectors/ner.ts`
- Create: `test/ner-detector.test.ts`

**Interfaces:**
- Consumes: `transformers()` from `@/server/models` (Task 1); `dictionaryNames` and `PersonDetector` (Task 2); `env.ANONYMIZER_MODEL`, which Task 4 adds — **this task must not run `npm run typecheck` green until Task 4**, so Step 6 adds the variable here and Task 4 adds the rest of its five places.
- Produces: `createNerDetector(): PersonDetector`, plus two exports for the tests: `windows(text: string): string[]` and `personsIn(tokens: TaggedToken[], window: string): string[]`.

**A refinement of the spec.** §9 of the spec says the model path gets no unit test, and that stands — no test here loads a model. But `windows` and `personsIn` are pure functions in *our* code, not reimplementations of the model's behaviour, and one of them is the defence against a silent leak. They are tested. The spec's argument was against testing a copy; testing the real function is a different thing.

- [ ] **Step 1: Write the failing tests**

Create `test/ner-detector.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { personsIn, windows, WINDOW_CHARS } from "@/server/privacy/detectors/ner";

/**
 * The model itself is not tested here — this suite loads no model, for the
 * same reason it opens no database connection. What is tested is the code
 * around it: the windowing that stops a name being silently dropped past the
 * model's 512-token limit, and the stitching that turns wordpieces back into
 * something the anonymizer can find.
 */
describe("ner detector windowing", () => {
  it("returns a short text as a single window", () => {
    assert.deepEqual(windows("Ask Marek Dvořák about it."), ["Ask Marek Dvořák about it."]);
  });

  it("never returns a window longer than the budget", () => {
    const paragraph = "Sentence about storage endurance. ".repeat(200);
    const text = `${paragraph}\n\n${paragraph}\n\n${paragraph}`;

    for (const window of windows(text)) {
      assert.ok(
        window.length <= WINDOW_CHARS,
        `window of ${window.length} chars exceeds the ${WINDOW_CHARS} budget`,
      );
    }
  });

  it("splits between paragraphs rather than inside one", () => {
    const a = "A".repeat(WINDOW_CHARS - 100);
    const b = "B".repeat(WINDOW_CHARS - 100);

    assert.deepEqual(windows(`${a}\n\n${b}`), [a, b]);
  });

  it("overlaps a hard split, so a name at the seam survives in one piece", () => {
    // One paragraph over the budget has to be cut somewhere, and a cut through
    // a name would lose it: neither half is a name the anonymizer can find.
    const filler = "x".repeat(WINDOW_CHARS - 10);
    const text = `${filler}Petra Horáková is here.`;

    const found = windows(text);

    assert.ok(found.length > 1, "expected the over-long paragraph to be split");
    assert.ok(
      found.some((w) => w.includes("Petra Horáková")),
      "a name at the split seam must appear whole in some window",
    );
  });

  it("keeps a name that sits in a later paragraph", () => {
    const text = "First paragraph.\n\nSecond paragraph mentioning Lucie Šimková.";

    assert.ok(windows(text).some((w) => w.includes("Lucie Šimková")));
  });
});

describe("ner detector stitching", () => {
  const window = "Petra Horáková and Marek Dvořák met.";

  it("stitches wordpieces back into a surface form", () => {
    const found = personsIn(
      [
        { entity: "B-PER", word: "Petra" },
        { entity: "I-PER", word: "Ho" },
        { entity: "I-PER", word: "##rá" },
        { entity: "I-PER", word: "##ková" },
      ],
      window,
    );

    assert.deepEqual(found, ["Petra Horáková"]);
  });

  it("separates two people that sit next to each other", () => {
    const found = personsIn(
      [
        { entity: "B-PER", word: "Petra" },
        { entity: "I-PER", word: "Ho" },
        { entity: "I-PER", word: "##rá" },
        { entity: "I-PER", word: "##ková" },
        { entity: "O", word: "and" },
        { entity: "B-PER", word: "Marek" },
        { entity: "I-PER", word: "D" },
        { entity: "I-PER", word: "##voř" },
        { entity: "I-PER", word: "##ák" },
      ],
      window,
    );

    assert.deepEqual(found, ["Petra Horáková", "Marek Dvořák"]);
  });

  it("drops a stitched form that is not in the window", () => {
    // The rejected model tagged the pieces of "Radek Pokorný" discontinuously
    // and stitching them gave "Poný", which is in no text anywhere. It must not
    // be reported: the anonymizer would not find it either, and a detector
    // that reports strings it did not see is a detector nobody can reason about.
    const found = personsIn(
      [
        { entity: "B-PER", word: "Po" },
        { entity: "I-PER", word: "##ný" },
      ],
      window,
    );

    assert.deepEqual(found, []);
  });

  it("ignores every tag that is not a person", () => {
    const found = personsIn(
      [
        { entity: "B-ORG", word: "Intel" },
        { entity: "B-LOC", word: "Brno" },
        { entity: "O", word: "shipped" },
      ],
      window,
    );

    assert.deepEqual(found, []);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="ner detector"`
Expected: FAIL — `Cannot find module '@/server/privacy/detectors/ner'`.

- [ ] **Step 3: Write the detector**

Create `src/server/privacy/detectors/ner.ts`:

```ts
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
    // keeps that fact local instead of passing a phantom name outward.
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern="ner detector"`
Expected: all pass. No model is loaded — the suite only calls `windows` and `personsIn`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Add the model variable so this file typechecks**

`env.ANONYMIZER_MODEL` does not exist yet. Add it now, in both places in `src/server/env.ts`; Task 4 adds `ANONYMIZER_PROVIDER` and the other three places of both.

In the schema, immediately after the `MODEL_CACHE_DIR` block from Task 1:

```ts
  // --- Anonymization --------------------------------------------------
  // The NER model that finds person names. Measured on the seed corpus at
  // 100% person precision against the heuristic detector's 50%; the larger
  // `bert-base-multilingual-cased-ner-hrl` was measured too and rejected.
  ANONYMIZER_MODEL: z
    .string()
    .min(1)
    .default("Xenova/distilbert-base-multilingual-cased-ner-hrl"),
```

In `BUILD_PHASE_PLACEHOLDERS`, after `MODEL_CACHE_DIR: "./.models",`:

```ts
  ANONYMIZER_MODEL: "Xenova/distilbert-base-multilingual-cased-ner-hrl",
```

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/server/privacy/detectors/ner.ts test/ner-detector.test.ts src/server/env.ts
git commit -m "feat(privacy): find people with a model instead of a guess

Xenova/distilbert-base-multilingual-cased-ner-hrl, in-process, quantized.
Measured over the seed corpus: 6/6 people, 10/10 occurrences, zero false
positives, against the heuristic detector's six. The larger
bert-base-multilingual-cased-ner-hrl was measured on the same corpus and
rejected — it missed a Czech surname and tagged its pieces discontinuously.

The windowing is not an optimisation. The model's 512-token limit truncates
silently, measured: a name past the boundary produces no PER tokens and no
error, which for a privacy control is the leak arriving quietly. Text is cut
at paragraph breaks inside a pessimistic 1536-character budget, and a hard
cut through an over-long paragraph overlaps so a name at the seam survives
whole in one window.

Nothing is wired to it yet.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TDX8fgBaSkSM5MaDDXV9Mq"
```

---

### Task 4: Selecting it, baking it, and refusing to start without it

**Files:**
- Create: `src/server/privacy/detectors/index.ts`
- Rename: `scripts/fetch-model.mjs` → `scripts/fetch-models.mjs`
- Modify: `src/server/env.ts` (schema + placeholders), `.env.example`, `docker-compose.yaml`, `test/env.ts`
- Modify: `src/server/rag/answer.ts` (swap the detector for the factory)
- Modify: `src/instrumentation.node.ts`, `Dockerfile:27`

**Interfaces:**
- Consumes: `createHeuristicDetector` (Task 2), `createNerDetector` (Task 3).
- Produces: `getPersonDetector(): PersonDetector`, cached for the life of the process; `env.ANONYMIZER_PROVIDER: "ner" | "heuristic"`.

- [ ] **Step 1: Write the factory**

Create `src/server/privacy/detectors/index.ts`:

```ts
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
```

- [ ] **Step 2: Add the provider variable to the schema and the placeholders**

In `src/server/env.ts`, inside the `// --- Anonymization ---` block added in Task 3, **above** `ANONYMIZER_MODEL`:

```ts
  // `ner` runs the model in this process; `heuristic` is the dictionary and
  // capitalised-bigram detector this project shipped with, which needs no
  // model. `ner` is the default because a stronger anonymizer nobody runs is a
  // claim rather than a control.
  ANONYMIZER_PROVIDER: z.enum(["ner", "heuristic"]).default("ner"),
```

In `BUILD_PHASE_PLACEHOLDERS`, above `ANONYMIZER_MODEL`:

```ts
  ANONYMIZER_PROVIDER: "heuristic",
```

The build placeholder is `heuristic` for the same reason `EMBEDDING_PROVIDER` is `mock` there: `next build` imports route modules and must not load a model.

- [ ] **Step 3: Add both to `.env.example`**

Insert after the `MODEL_CACHE_DIR` block:

```
# --- Anonymization ------------------------------------------------------
# ner       = a NER model runs in-process. Measured on the seed corpus at 100%
#             person precision. This is the default.
# heuristic = name dictionary plus a capitalised-bigram guess, no model.
#             Measured at 50% person precision; what the tests use.
# There is no fallback: if ner is selected and the model is not in the image,
# the app refuses to start rather than quietly redacting less.
ANONYMIZER_PROVIDER=ner
ANONYMIZER_MODEL=Xenova/distilbert-base-multilingual-cased-ner-hrl

```

- [ ] **Step 4: Add both to the compose file**

In `docker-compose.yaml`, after `MODEL_CACHE_DIR: ${MODEL_CACHE_DIR}`:

```yaml
      ANONYMIZER_PROVIDER: ${ANONYMIZER_PROVIDER}
      ANONYMIZER_MODEL: ${ANONYMIZER_MODEL}
```

- [ ] **Step 5: Keep the test suite model-free**

In `test/env.ts`, add to `DEFAULTS`, after `EMBEDDING_PROVIDER: "mock",`:

```ts
  // No test loads a model. `answer.test.ts` reaches the detector factory
  // through askQuestion, so without this the suite would try to.
  ANONYMIZER_PROVIDER: "heuristic",
```

- [ ] **Step 6: Swap the call site onto the factory**

In `src/server/rag/answer.ts`, replace the import added in Task 2:

```ts
import { createHeuristicDetector } from "@/server/privacy/detectors/heuristic";
```

with:

```ts
import { getPersonDetector } from "@/server/privacy/detectors";
```

and replace:

```ts
  const anonymizer = createAnonymizer(createHeuristicDetector());
```

with:

```ts
  const anonymizer = createAnonymizer(getPersonDetector());
```

- [ ] **Step 7: Load the model at startup**

In `src/instrumentation.node.ts`, add two imports:

```ts
import { env } from "@/server/env";
import { getPersonDetector } from "@/server/privacy/detectors";
```

and insert this between the migrations block and `startRetentionSchedule()`:

```ts
// Loaded here rather than on the first question. Both timings fail closed — a
// detector that cannot load throws, and a throwing `redact` means no text
// leaves the process — so this prevents no leak. What it changes is who finds
// out: the healthcheck, or a user.
try {
  await getPersonDetector().warmUp();
} catch (error) {
  logger.error(
    // The effective value, not `process.env` — the variable is defaulted by
    // zod, so the raw environment reads undefined in the common case and would
    // name nothing at the one moment an operator needs it named.
    { err: error, provider: env.ANONYMIZER_PROVIDER },
    "startup failed: could not load the person detector",
  );
  throw error;
}
```

- [ ] **Step 8: Bake both models into the image**

Rename the script and teach it both models:

```bash
git mv scripts/fetch-model.mjs scripts/fetch-models.mjs
```

Replace the contents of `scripts/fetch-models.mjs`:

```js
/**
 * Downloads the models into the image at BUILD time.
 *
 * The running container has `allowRemoteModels = false`, so this is the only
 * chance to fetch them — and it means `docker compose up` works with no
 * network at all and cannot fail on a third party's uptime.
 *
 * Must request the same dtype the app uses, or it would cache the float32
 * weights and the runtime would then look for quantized ones it does not have.
 */
const cacheDir = process.env.MODEL_CACHE_DIR ?? "./.models";

const embeddingModel = process.env.EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2";
const anonymizerModel =
  process.env.ANONYMIZER_MODEL ?? "Xenova/distilbert-base-multilingual-cased-ner-hrl";

const { pipeline, env } = await import("@huggingface/transformers");
env.cacheDir = cacheDir;
env.allowRemoteModels = true;

// Prove the cached files actually load and produce what the app expects,
// rather than only that some bytes were written.

let startedAt = Date.now();
const extractor = await pipeline("feature-extraction", embeddingModel, { dtype: "q8" });
const [dims] = (
  await extractor(["build-time verification"], { pooling: "mean", normalize: true })
).tolist();
console.log(
  `fetched ${embeddingModel} (q8) into ${cacheDir} in ${Date.now() - startedAt}ms, ${dims.length} dimensions`,
);

startedAt = Date.now();
const tagger = await pipeline("token-classification", anonymizerModel, { dtype: "q8" });
const tagged = await tagger("Petra Horáková");
const people = tagged.filter((t) => t.entity.endsWith("PER")).length;
console.log(
  `fetched ${anonymizerModel} (q8) into ${cacheDir} in ${Date.now() - startedAt}ms, ${people} person tokens on the smoke input`,
);

if (people === 0) {
  throw new Error(`${anonymizerModel} loaded but tagged no person — wrong model or wrong dtype`);
}
```

In `Dockerfile`, update the comment and the command:

```dockerfile
# Bake the models into the image. The runtime has remote model loading
# disabled, so this is the only chance to fetch them — and it means the
# container needs no network at all.
RUN node scripts/fetch-models.mjs
```

- [ ] **Step 9: Verify**

Run: `npm run typecheck && npm test`
Expected: clean, all pass. The suite runs with `ANONYMIZER_PROVIDER=heuristic` and loads nothing.

Then prove the five places are all covered:

Run: `for v in ANONYMIZER_PROVIDER ANONYMIZER_MODEL MODEL_CACHE_DIR; do echo "== $v"; grep -rln "$v" src/server/env.ts .env.example docker-compose.yaml; done`
Expected: all three files listed for each variable.

- [ ] **Step 10: Commit**

```bash
git add src/server/privacy/detectors/index.ts src/server/env.ts .env.example docker-compose.yaml test/env.ts src/server/rag/answer.ts src/instrumentation.node.ts scripts/fetch-models.mjs Dockerfile
git commit -m "feat(privacy): make the NER detector the default, and bake it in

ANONYMIZER_PROVIDER selects it, defaulting to ner: a stronger anonymizer
nobody runs is a claim rather than a control, so docker compose up with no
key and no network must demonstrate the 100% column and not the 50% one.

No fallback to heuristic when the model is missing — that is the silent
downgrade env.ts already refuses for a keyless anthropic provider, and a
privacy control is the last place to introduce one. The model is loaded at
startup instead, so a broken configuration stops the deployment rather than
failing every question.

The image grows from 23 MB of model to 152 MB. The whole increase is the
multilingual vocabulary that makes the Czech names work.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TDX8fgBaSkSM5MaDDXV9Mq"
```

---

### Task 5: The measured pass against the running stack

**Files:** none. This task produces numbers, which Task 6 writes down.

Nothing here is optional. The NER path has no automated test by design, so this pass is the controlling verification — the same role the concurrent-burst measurement plays for slice 15's reservation SQL.

- [ ] **Step 1: Build and bring the stack up**

```bash
docker compose up --build -d
docker compose logs -f app | head -40
```

Expected in the log: `application starting`, then a line `person detector model loaded` carrying `model` and `loadMs`, then `application started`. Record `loadMs`.

Expected **not** in the log: any person's name, anywhere.

- [ ] **Step 2: Confirm the image cost**

```bash
docker compose images app
docker run --rm --entrypoint sh "$(docker compose images -q app)" -c 'du -sh .models && du -sh .models/*'
```

Record the total and the per-model split. The plan claims 23 MB → 152 MB; write down what it actually is.

- [ ] **Step 3: Re-measure the corpus through the app's own detector**

The builder stage has the source, the test resolver and the baked models, so the app's real detector can be run over the real seed corpus:

```bash
docker build --target builder -t pkb-slice16-measure .
docker run --rm pkb-slice16-measure bash -c 'cat > /tmp/measure.ts <<"EOF"
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createAnonymizer } from "@/server/privacy/anonymizer";
import { createHeuristicDetector } from "@/server/privacy/detectors/heuristic";
import { createNerDetector } from "@/server/privacy/detectors/ner";
import { KNOWN_FULL_NAMES, KNOWN_SURNAMES } from "@/server/privacy/names";

const TRUE = [...KNOWN_FULL_NAMES, ...KNOWN_SURNAMES];
const isPerson = (v: string) => TRUE.some((n) => v.includes(n) || n.includes(v));

const dir = "seed";
const files = (await readdir(dir, { withFileTypes: true }))
  .filter((e) => e.isFile() && /\.(md|txt)$/i.test(e.name)).map((e) => e.name).sort();
const docs: string[] = [];
for (const f of files) docs.push(await readFile(path.join(dir, f), "utf8"));
docs.push(await readFile(path.join(dir, "sources", "10-networking-nic.md"), "utf8"));

for (const [label, detector] of [["heuristic", createHeuristicDetector()], ["ner", createNerDetector()]] as const) {
  const values = new Set<string>();
  let occurrences = 0;
  const startedAt = Date.now();
  for (const text of docs) {
    const a = createAnonymizer(detector);
    const redacted = await a.redact(text);
    occurrences += (redacted.match(/\[PERSON_\d+\]/g) ?? []).length;
    for (const m of redacted.matchAll(/\[PERSON_\d+\]/g)) values.add(a.restore(m[0]));
  }
  const tp = [...values].filter(isPerson);
  const fp = [...values].filter((v) => !isPerson(v));
  console.log(`${label}: ${values.size} distinct, ${tp.length} true, ${fp.length} false, ${occurrences} occurrences replaced, ${((tp.length / values.size) * 100).toFixed(0)}% precision, ${Date.now() - startedAt}ms`);
  if (fp.length) console.log(`  false: ${fp.join(" | ")}`);
}
EOF
node --import ./test/env.ts --import ./test/resolve.ts /tmp/measure.ts'
```

Expected: `heuristic: 12 distinct, 6 true, 6 false, … 50% precision` and `ner: 6 distinct, 6 true, 0 false, 10 occurrences replaced, … 100% precision`. Record both lines verbatim, including the false-positive list and the timings.

Note the PDF is counted through its source Markdown, because `unpdf` does not run outside the app's runtime. Step 5 covers the PDF through the real extractor.

- [ ] **Step 4: Delete the measurement image**

```bash
docker image rm pkb-slice16-measure
```

- [ ] **Step 5: The round trip in the UI, including the PDF's one person**

Sign in at `http://localhost:3000` as `alice`, let the seed load, and ask:

1. *"What did Marek Dvořák say about memory training?"* — the privacy panel must show the redacted question containing `[PERSON_1]`, and the answer must read with `Marek Dvořák` restored.
2. *"What did David Kraus configure on the NIC?"* — this retrieves from `10-networking-nic.pdf`, which is the only person occurrence that reaches the detector through the real PDF extractor. Confirm `[PERSON_1]` in the redacted question and the name restored in the answer.

Record the per-question latency shown for each, and compare against a run with `ANONYMIZER_PROVIDER=heuristic` for the added cost.

- [ ] **Step 6: Demonstrate the seam from the other side**

```bash
ANONYMIZER_PROVIDER=heuristic docker compose up -d --force-recreate app
```

Ask the same question. Expected: it still works, the startup log has **no** `person detector model loaded` line, and Step 3's heuristic numbers are what this configuration produces.

- [ ] **Step 7: Demonstrate the refusal to start**

```bash
ANONYMIZER_MODEL=Xenova/not-a-real-model docker compose up -d --force-recreate app
docker compose logs app | tail -20
docker compose ps app
```

Expected: `startup failed: could not load the person detector`, the container not healthy, and **no** secret, document text or person name in the message.

- [ ] **Step 8: Put the stack back and tear it down**

```bash
docker compose up -d --force-recreate app
docker compose down
```

- [ ] **Step 9: Commit nothing**

This task changes no files. Its output is the numbers Task 6 writes down. If any measurement contradicts a claim in the spec or this plan, **the document is what changes** — record what happened, not what was predicted.

---

### Task 6: Writing it down

**Files:**
- Modify: `README.md` (anonymization section, configuration table, known gaps, roadmap)
- Modify: `docs/decisions.md`
- Modify: `CLAUDE.md` §4 and §7

**Interfaces:** none.

- [ ] **Step 1: Rewrite the measured table in the README**

In *What the detector actually does, measured*, replace the single table with this shape, filling every `‹…›` from **Task 5's recorded output** and nothing else:

```
| | `heuristic` (before) | `ner` (default) |
| --- | --- | --- |
| People, distinct | 6 / 6 | ‹…› |
| People, occurrences replaced | 10 / 10 | ‹…› |
| False positives | 6 | ‹…› |
| Person precision | 50% | ‹…› |
| E-mail addresses | 6 / 6 | 6 / 6 |
| Phone numbers | 3 / 3 | 3 / 3 |
```

The e-mail and phone rows are identical in both columns because they are the same two regexes; the detector seam does not touch them.

Then rewrite the prose around it. Three things it must say: the default detector is now a model; the "naive detector honestly described" defence still stands but now describes the `heuristic` provider; and the six false positives are named as what the old column produced, not as current behaviour.

State the cost plainly in the same section: the model payload, the added per-question latency, and the startup load, all from Task 5.

Add the sentence the spec requires: **recall is not what improved.** The heuristic detector also replaced all 10 occurrences, by construction — `split`/`join` means finding a name once finds it everywhere. What changed is precision.

- [ ] **Step 2: Update the configuration table**

Add `ANONYMIZER_PROVIDER` and `ANONYMIZER_MODEL` rows, and confirm the `MODEL_CACHE_DIR` row from Task 1 reads correctly. Add one line noting that an existing `.env` carrying `EMBEDDING_CACHE_DIR` keeps working, because the new variable falls back to the same default.

- [ ] **Step 3: Correct the roadmap item**

In *What I would build next*, item 2 is now built. Follow the pattern the BM25 and shared-ceiling items already set: say it is built, link to the section, and correct what the item claimed. Two things to correct — "the seam is already there" was false, and the improvement is precision rather than recall.

- [ ] **Step 4: Add the new gaps**

Append to *Known gaps and deliberate debt*, numbered from 30:

30. The model's ten training languages do not include Czech. It finds every Czech name in this corpus, measured — and the other candidate, trained on the same ten, did not. Working here is evidence, not a guarantee.
31. Reconstruction can miss, and the honest bound is "never corrupts". A stitched surface form absent from its window is dropped, silently, and by design preferable to splicing at a guessed offset.
32. `PER` only. The model also emits `ORG` and `LOC`; neither is used. Addresses, dates of birth, national ID and account numbers remain undetected, as gap 4's neighbours already say.
33. The image grew by the figure Task 5 measured. The whole increase is the multilingual vocabulary that makes the Czech names work.
34. No automated test covers the model call itself — `windows` and `personsIn` are tested, the pipeline is not. Same admission as gaps 23 and 29, and the controlling verification is Task 5's measured pass.

Gap 4 (anonymization runs on the answering path only, not at ingest and not on filenames) is unchanged and stays exactly as written. Gap 11 is about retrieval's two-token identifier rule, not the anonymizer; do not touch it.

- [ ] **Step 5: Add the decision lines**

Append to `docs/decisions.md`, in the existing `YYYY-MM-DD — <decision> — <why> — <what was rejected>` form, dated `2026-09-03`:

- The model choice, and the larger candidate rejected on measurement.
- The bigram leaving the default path — 0 of 10 true occurrences, 6 of 6 false positives.
- Strings rather than spans, forced by a pipeline with no offsets.
- The 1,536-character window, and the silent truncation that makes it a correctness requirement.
- The eager startup load, with its narrow claim: not leak prevention, but who finds out.
- `EMBEDDING_CACHE_DIR` → `MODEL_CACHE_DIR`, forced by process-global library state.
- `ner` as the default, and the rejected fallback-with-a-warning.

- [ ] **Step 6: Update the governing brief**

In `CLAUDE.md` §4, add `privacy/detectors/` to the layout tree with a one-line comment.

In `CLAUDE.md` §7, the anonymizer bullet that begins "Detects e-mails and phone numbers by regex; person names from a seed dictionary plus a capitalised-bigram heuristic" no longer describes the default. Rewrite it to name the detector seam and both implementations.

Do **not** add a row to §5's seam table. That section is about the seams across which text leaves the process; this model runs in-process, and blurring that would undercut the one distinction the privacy argument rests on.

- [ ] **Step 7: Check the documents agree**

Run: `grep -rn "50%" README.md docs/decisions.md`
Expected: every surviving mention is explicitly about the `heuristic` provider or the before column.

Run: `grep -rn "capitalised-bigram\|bigram" README.md CLAUDE.md`
Expected: no sentence still presents it as what the app does by default.

- [ ] **Step 8: Commit**

```bash
git add README.md docs/decisions.md CLAUDE.md
git commit -m "docs: record the stronger anonymizer, and what it did not improve

The measured table becomes before-and-after, and says the thing the roadmap
item got wrong: recall did not improve. The old detector replaced all ten
occurrences too — split/join means finding a name once finds it everywhere.
Precision went from 50% to 100%, and that is the whole of the win.

The item also claimed the seam was already there. It was not, and saying so
is cheaper than a reviewer finding it.

Five new gaps, including the one that matters most: neither candidate model
lists Czech among its training languages, so this corpus working is evidence
rather than a guarantee.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TDX8fgBaSkSM5MaDDXV9Mq"
```
