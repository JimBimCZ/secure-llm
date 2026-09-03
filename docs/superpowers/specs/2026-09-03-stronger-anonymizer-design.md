# Slice 16 — a stronger anonymizer, and the seam the README claimed was already there

**Date:** 2026-09-03
**Status:** designed
**Requirement it serves:** CLAUDE.md §3, *LLM and data* — "anonymization is mandatory and must
be visible" — and §7, which fixes the anonymizer's shape. README roadmap item 2.

---

## 1. The claim this slice tests, and the measurement that had to come first

The roadmap item reads:

> **A stronger anonymizer, behind the same interface.** The current one is a regex detector
> honestly described. A NER model would raise precision above 50% without changing a single
> call site — the seam is already there.

Two assertions, both unverified when they were written. The first — that a NER model raises
precision on **this** corpus — is a guess about models trained on languages this corpus is not
written in. The second — that the seam is already there — is false, and §2 deals with it.

The first was settled by measurement before any of this was designed, because the whole slice
collapses if a model cannot find a Czech surname the dictionary already catches. The two
credible in-process candidates were run over the full seed corpus (10 documents, 47,263
characters, **10 person occurrences**, every one a full name) and scored against the same
ground truth the README publishes:

| | current: regex + dictionary + bigram | `bert-base-multilingual-cased-ner-hrl` | `distilbert-base-multilingual-cased-ner-hrl` |
| --- | --- | --- | --- |
| Model size (q8) | — | 170 MB | 129 MB |
| Distinct people found | 6 / 6 | 5 / 6 | **6 / 6** |
| Person **occurrences** found | 10 / 10 | — | **10 / 10** |
| False positives | **6** | 1 | **0** |
| Person precision | **50%** | 83% | **100%** |
| Inference | — | 116 ms/window | 69–74 ms/window |

The baseline reproduced the README's published figures exactly — 12 distinct values, 6 true, 6
false, `Arrow Lake`, `Curve Optimizer`, `Adaptive-Sync`, `Ultra High`, `Display Stream`,
`Wi-Fi` — so the comparison is against the real detector and not a reconstruction of it.

**Recall is not what improves.** The baseline finds all 10 occurrences too, by construction: it
replaces a detected value with `split`/`join` across the whole text, so finding a name once
finds it everywhere. What changes is precision, from 50% to 100%. Any claim that this slice
catches names the old detector leaked would be false on this corpus, and the README must not
make one.

The corpus figure counts the seed PDF through its source Markdown rather than through
`extractDocumentText`, because `unpdf` does not run outside the app's runtime. The PDF
contributes one person occurrence (`David Kraus`), and step 3 of §11 re-measures through the
running app, where the real extractor is in the path.

Three findings shape everything below.

**The smaller model beats the larger one.** `bert-base-multilingual-cased-ner-hrl` missed
`Radek Pokorný` — a Czech name — and tagged the pieces of it discontinuously, so that stitching
them yielded `Poný`, a string that appears nowhere in the corpus.
`distilbert-base-multilingual-cased-ner-hrl` found every occurrence and produced nothing false. It is 41 MB smaller and 40% faster. Neither model lists Czech among its ten
training languages; one copes and one does not, and no amount of reading the model cards would
have said which. This is the entire justification for probing rather than assuming, and the
rejected model earns its place in `docs/decisions.md`.

**The pipeline exposes no character offsets.** Output items carry `entity`, `score`, `index`
and a wordpiece `word` — `"Ho"`, `"##rá"`, `"##ková"` — and the tokenizer returns only
`input_ids` and `attention_mask`; `return_offsets_mapping` is not supported. §3 is the
consequence.

**A name past the model's window is silently dropped.** §4.

## 2. The seam this slice actually builds

`createAnonymizer()` takes no argument and there is exactly one implementation. There is no
seam. Saying so is cheaper than the alternative, which is a reviewer discovering it, and it is
the same correction slice 14 made to its own stated precondition and slice 15 made to slice
11's rejected decision.

```ts
// src/server/privacy/detectors/types.ts
export interface PersonDetector {
  readonly name: string;
  /** Surface strings in `text` that are person names. Never logged. */
  detect(text: string): Promise<string[]>;
}
```

| Implementation | Selected by | What it is |
| --- | --- | --- |
| `ner` | `ANONYMIZER_PROVIDER=ner` (default) | dictionary + the model, in-process |
| `heuristic` | `ANONYMIZER_PROVIDER=heuristic` | dictionary + capitalised bigram + sentence-starter list — today's detector, moved verbatim |

The dictionary belongs to both. A name someone has already told the app about is a certainty,
it costs nothing, and it is the "directory export, refreshed on a schedule" story `names.ts`
already tells. The model is what replaces guessing.

This is the third seam in the project and it is shaped like the other two: an interface, a
folder of implementations, a factory reading one env var, and a call site that names none of
them. It is also the seam with the strongest claim to being real, because the two
implementations here disagree about how they work rather than only about where they send
bytes.

## 3. The mechanism: strings, not spans

A detector returns **surface strings**, and the anonymizer replaces them with
`split(value).join(placeholder)` — the mechanism the dictionary path already uses at
`anonymizer.ts:120`.

This is forced, not chosen. With no offsets from the pipeline, a NER implementation has to
stitch wordpieces back into a surface form (`"Ho"` + `"##rá"` + `"##ková"` → `"Horáková"`) and
then find that form in the text. Measured, all 10 reconstructed spans appeared verbatim in
their own window, so on this corpus nothing is lost. The failure mode when reconstruction goes
wrong is worth stating precisely, because it is the reassuring direction: a string that is not
in the text matches nothing, so the outcome is a **miss, never a corruption**. The rejected
model's `Poný` is exactly that case, and it is why the anonymizer gets a test for it.

`redact` therefore becomes `async`, and `answer.ts:127` awaits the question and then each
retrieved chunk. Measured: 7 ms for a question, ~400 ms for six chunks. Batching them into one
call was *slower* — 631 ms — because the pipeline pads to the longest input, so the interface
is not reshaped around a batch that does not pay.

Everything else in `anonymizer.ts` is untouched: the e-mail and phone regexes (6/6 and 3/3
with no false positives — they are not person detection and no model here does them better),
placeholder allocation, the one-instance-per-request mapping, `restore`, `counts`.

## 4. Windowing, because silent truncation is a leak

The model's window is 512 wordpieces. Measured on this corpus at ~3.7 characters per wordpiece:
a 1,500-character chunk is 401 wordpieces and fits; 2,000 characters is 519 and does not. What
happens then was measured rather than assumed — a name placed past the boundary produced **no
`PER` tokens at all**. The pipeline does not throw. It truncates, and says nothing.

For a privacy control that is not a performance footnote, it is the leak the control exists to
prevent, arriving quietly. So `ner.ts` splits text on blank lines into windows budgeted at

```
512 tokens × 3 characters per token = 1536 characters
```

the same pessimistic convention `chunk.ts:25` already justifies for the embedder, against a
measured 3.7. The app's own chunks are 1,500 characters, so in the ordinary case a chunk is one
window; the detector does not assume it, because it is a general text function and the next
extractor change could make it false.

## 5. Why the bigram heuristic leaves the default path

Measured, on the corpus it was written against: the capitalised-bigram heuristic contributed
**0 of the 10** true person occurrences and **6 of the 6** false positives. Every real name it
found, the dictionary had already found.

The README defends its false positives — a redacted `Arrow Lake` is restored before the user
sees it, so over-redaction is the safe direction — and that defence remains true. It is just no
longer necessary. The heuristic survives inside the `heuristic` detector, which is what the
tests use and what a model-free build gets; it stops being what the app does by default.

## 6. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANONYMIZER_PROVIDER` | `ner` | `ner` \| `heuristic` |
| `ANONYMIZER_MODEL` | `Xenova/distilbert-base-multilingual-cased-ner-hrl` | Model id in env, never at a call site — the rule `LLM_MODEL` and `EMBEDDING_MODEL` already follow |
| `MODEL_CACHE_DIR` | `./.models` | **Renamed from `EMBEDDING_CACHE_DIR`** |

`ner` is the default because a stronger anonymizer that nobody runs is a claim rather than a
control: `docker compose up` with no key and no network must demonstrate the 100% column, not
the 50% one. There is deliberately **no fallback to `heuristic` when the model is absent** —
that is the silent downgrade `env.ts` already refuses for a keyless `anthropic`, and a privacy
control is the last place to introduce one.

The rename is forced by the library rather than by taste. `@huggingface/transformers` exposes
`env.cacheDir` and `env.localModelPath` as **process-global** settings (`local.ts:24`). With
two models in one process, the variable named for embeddings would be configuring the
anonymizer too, and whichever loader ran first would win. One module — `src/server/models.ts` —
sets them once from `MODEL_CACHE_DIR`, and both loaders call it. Seven files carry the old name:
`src/server/env.ts` (schema and build placeholders), `.env.example`, `docker-compose.yaml`,
`scripts/fetch-model.mjs`, `src/server/ai/embedders/local.ts`, `README.md`, and
`docs/implementation-plan.md`.

`scripts/fetch-model.mjs` bakes **both** models at build time. The runtime keeps
`allowRemoteModels = false`, so the container still never reaches the Hugging Face Hub and
`docker compose up` still works with no network.

## 7. Startup

`instrumentation.node.ts` loads the detector's model after migrations. A missing or misnamed
model stops the deployment instead of failing every question.

The claim is deliberately narrow. Both timings fail closed — a detector that cannot load throws,
and `redact` throwing means no text leaves the process — so eager loading prevents no leak. What
it changes is *who finds out*: the healthcheck, or a user. Measured cost is ~7 s on a cold page
cache and ~0.9 s warm, against a 40 s healthcheck start period.

The embedder stays lazy, and the asymmetry is deliberate rather than accidental: it is loaded by
the first question either way, and its failure degrades retrieval rather than the privacy
boundary.

## 8. What changes, file by file

### `src/server/models.ts` (new)

The one place that configures `@huggingface/transformers` for this process — `cacheDir`,
`localModelPath`, `allowRemoteModels = false` — called by both model loaders. Exists because
those settings are global and two callers now depend on them.

### `src/server/privacy/detectors/types.ts` (new)

`PersonDetector`, and nothing else.

### `src/server/privacy/detectors/dictionary.ts` (new)

`dictionaryNames(text): string[]`, shared by both detectors. `names.ts` stays what it is — a
list — because its docblock promises the list comes from elsewhere in a real deployment.

### `src/server/privacy/detectors/heuristic.ts` (new)

Today's bigram, sentence-starter list and dictionary lookup, moved out of `anonymizer.ts`
without behavioural change. The existing tests are the proof of that.

### `src/server/privacy/detectors/ner.ts` (new)

Loads the model once per process, windows text at 1,536 characters on blank lines, runs
token-classification, stitches `B-PER`/`I-PER` wordpieces into surface strings, unions with
`dictionaryNames`. Logs the model id and load time; **never** a detected value.

### `src/server/privacy/detectors/index.ts` (new)

`getPersonDetector()`, cached for the life of the process because it holds a loaded model.
Mirrors `src/server/ai/index.ts`.

### `src/server/privacy/anonymizer.ts`

`createAnonymizer(detector)`. `redact` becomes `async`. The bigram, the sentence-starter list
and the dictionary loop leave. Regexes, mapping, `restore` and `counts` stay exactly as they
are.

### `src/server/rag/answer.ts`

Awaits `redact` for the question and for each chunk. No other change — the ordering, the single
shared instance and the `Privacy` payload are unaffected.

### `src/server/env.ts`, `.env.example`, `docker-compose.yaml`, `scripts/fetch-model.mjs`, `Dockerfile`

The two new variables and the rename. `fetch-model.mjs` fetches both models and verifies each
loads, rather than only that bytes were written — the check it already makes for the embedder.

### `src/instrumentation.node.ts`

Eager model load, per §7.

### `test/anonymizer.test.ts`

Existing cases constructed with the `heuristic` detector, plus the stub-detector cases in §9.

## 9. Tests

Every existing case stays and is re-pointed at the `heuristic` detector. That is the proof the
refactor moved code without changing behaviour, and it is worth more than any new assertion
here.

New cases use a stub detector, so they run with no model:

1. The anonymizer replaces **exactly** what the detector returns, and nothing else.
2. A value the detector reports that is **not** present in the text changes the text not at all
   — the reconstruction-miss direction of §3, the failure the rejected model demonstrated.
3. One instance numbers a value identically across the question and every chunk.
4. Round trip is byte-identical.

The model path itself gets **no** unit test. This suite loads no model for the same reason it
opens no database connection: a test that does can pass for the wrong reason, and a TypeScript
reimplementation of wordpiece stitching would test the copy rather than the model. The
controlling verification is the measured pass in §11, recorded in the README — the same
admission gaps 23 and 29 already make for SQL.

## 10. New gaps this opens

1. **The model's ten training languages do not include Czech.** It finds every Czech name in
   this corpus, measured — and the other candidate, trained on the same ten, did not. Working
   here is evidence, not a guarantee, and a corpus in a language further from the ten would need
   its own measurement.
2. **Reconstruction can miss, and the honest bound is "never corrupts".** A stitched surface
   form absent from the text replaces nothing. Silent, and by design preferable to splicing at
   a guessed offset.
3. **`PER` only.** The model also emits `ORG` and `LOC`; neither is used, because neither is
   what §7 asks for. Addresses, dates of birth, national ID and account numbers remain
   undetected, exactly as the README already says.
4. **The image grows from 23 MB of model to 152 MB.** The whole increase is the multilingual
   vocabulary that makes the Czech names work.
5. **No automated test covers the model path** (§9).
6. Existing gap 4 is unchanged: anonymization still runs on the answering path only, not at
   ingest and not on filenames.

## 11. Verification

Automated:

- `npm run typecheck` and `npm test` clean, with the anonymizer suite unchanged in substance.

Measured against the running stack, `docker compose up` from a fresh build, no API key:

1. Startup log carries the model id and load time; no detected value appears in any log line.
2. A question naming a person shows the redacted question in the UI with `[PERSON_1]`, and the
   answer reads with the real name restored.
3. The full seed corpus re-measured through the running app: 6/6 distinct people, 10/10
   occurrences, 0 false positives, e-mails 6/6 and phones 3/3 unchanged.
4. `ANONYMIZER_PROVIDER=heuristic` reproduces the old numbers, including the six false
   positives — the seam demonstrated from both sides.
5. `ANONYMIZER_MODEL` set to a model that is not in the image: the app **fails to start**, with
   a message naming the variable and no secret or document text in it.
6. Added latency of a question recorded, against the pre-slice baseline.

## 12. Documentation on landing

- **README** — the measured table becomes before-and-after; the cost stated plainly (model
  payload 23 MB → 152 MB, ~400 ms per question, one-off load); the two new variables and the
  rename; the roadmap item's "the seam is already there" corrected rather than quietly built
  past; the new gaps of §10.
- **`docs/decisions.md`** — the model choice and the larger model it rejected, the bigram's
  removal, strings-not-spans, the 1,536-character window, the eager load, and the rename.
- **CLAUDE.md §4 and §7** — the layout gains `privacy/detectors/`, and §7's description of the
  anonymizer gains the detector it now takes. Deliberately **not** §5: that section is about the
  seams across which text leaves the process, and this model runs in-process. Putting a
  `PersonDetector` in the same table as `LlmProvider` would blur the one distinction the
  project's privacy argument rests on.
