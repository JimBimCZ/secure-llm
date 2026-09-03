# Slice 14 — a BM25 arm for prose

**Date:** 2026-09-03
**Status:** implemented — see §7, *Deviations, as built*, for the three points where the
shipped arm differs from what is designed above
**Requirement it serves:** CLAUDE.md §6 — the citation guarantee. The promise is that an
answer without a source is never shipped. Its mirror-image failure is the one measured below:
refusing to answer from a document the app has indexed, which the user cannot tell apart from
an honest "I don't have that."

---

## 1. The measured miss

Slices 10 and 13 each opened with a question the corpus answers and retrieval refused. This
slice opens the same way, and the miss is larger than either of theirs.

Fifteen prose questions — no part numbers, so the identifier arm never runs — were put to the
vector arm against the seed corpus on the running stack. **Five were refused outright**: zero
chunks cleared the 0.25 floor, so retrieval returned nothing and the app said "Not found in
your knowledge base." without a model call.

Two of the five are the clearest evidence in the project so far, because in both the user is
half-remembering their own wording:

| Question | Vector arm | BM25 over the same corpus |
| --- | --- | --- |
| *what mistakes have I already made once and want to avoid repeating?* | **0 hits**, best 0.238 | `01-cpu-notes#0` at rank 1 — the note opens *"the mistakes I've already made once and don't want to repeat"* |
| *what is the arithmetic I actually use for sizing?* | **0 hits**, best 0.173 | `06-psu-sizing#0` at rank 1 — the section is titled *"The arithmetic I actually use"* |

A sentence embedder compresses a passage to 384 dimensions and keeps its meaning. It does not
keep the fact that you wrote *"the arithmetic I actually use"* in those words. For a personal
knowledge base that is not an edge case, it is the house style of the questions: the user is
searching text they themselves wrote and partly remember.

This is the same class of failure slice 10 recorded for `ddr5-6000` versus `ddr5-5600`, at a
different scale. There, the embedder could not distinguish two identifiers. Here it cannot
recognise a phrase it has already read.

## 2. Two findings that shaped the design

**Finding A — the `simple` dictionary is wrong for prose.** Measured first with the existing
`content_tsv`: *"what did I underweight for years?"* ranked the answering chunk **7th**, and
the section is titled *"Ergonomics, which I underweighted for years"*. `simple` does no
stemming, so `underweight` and `underweighted` are unrelated tokens. Recomputed with an
`english` tsvector, the same question ranks that chunk **1st**. This is README gap 12 — "the
lexical arm does no stemming" — showing up as a concrete miss.

It does not follow that the existing column should change dictionary. Stemming a part number
can only lose information, which is why slice 10 chose `simple` and why that choice stands.
The two arms want opposite things from the tokenizer, so they get two columns.

**Finding B — IDF-mass coverage separates answerable from unanswerable.** The open risk in any
prose arm is that it matches *something* for every question, and "Not found in your knowledge
base." is produced by retrieval returning nothing. Measured, per chunk, as the share of the
question's total IDF that the chunk accounts for:

| | best coverage over the corpus |
| --- | --- |
| **In corpus** (8 questions) | 1.00, 1.00, 1.00, 0.79, 0.70, 0.69, 0.63, **0.34** |
| **Out of corpus** (6 questions) | 0.23, 0.16, 0.13, and **three returning no rows at all** |

Three of the six unanswerable questions — *capital of Peru*, *repot a monstera*, *what should I
cook for dinner* — produce **zero postings**. The `english` configuration strips the stopwords,
and nothing survives that the corpus contains. For those the refusal is structural rather than
thresholded, which is the strongest form it can take.

The remaining three sit at ≤0.23 against ≥0.63 for seven of the eight real questions. The lone
in-corpus outlier is *"what contradiction did I never get to the bottom of?"* at 0.34, which is
a vague question by any standard.

**Measured cost:** the whole BM25 query runs in 19.9 ms on the seed corpus with the `english`
vector computed on the fly; 12.2 ms of that is the sequential scan computing it, which a stored
generated column removes. Next to an in-process embedding call and a model call, this is noise.

## 3. Design

### 3.1 A second generated tsvector

`chunks.content_tsv_en`, `GENERATED ALWAYS AS to_tsvector('english', content) STORED`, with its
own GIN index. `content_tsv` is untouched and goes on serving the identifier arm.

Generated, for the reason slice 10 gave: it cannot drift from the content it indexes and no
write path has to be kept in step. Postgres computes a stored generated column for existing
rows when the column is added, so every already-indexed chunk becomes prose-searchable on the
migration with nothing re-uploaded — the same property slice 10 relied on, and the opposite of
gap 5, where the PDF repair reaches only documents ingested after it.

Cost: roughly one more tsvector per chunk on disk.

- **Rejected:** changing `content_tsv` to `english` and using one column for both arms. It
  would stem the identifiers the first arm exists to match exactly.

### 3.2 BM25 computed in SQL, with no extension

Postgres has no BM25. `ts_rank_cd` has term frequency and length normalisation but **no IDF** —
it has no notion that *arithmetic* is rarer than *the*, which is the whole of what makes a
prose ranker work. So the score is computed from the stored tsvector:

- `tf` — length of the positions array, via `unnest(tsvector)`.
- `df` — chunks containing the lexeme, counted across the owner's own chunks, per query.
- `|d|` and `avgdl` — lexeme occurrence counts over the owner's chunks.
- `k1 = 1.2`, `b = 0.75` — the canonical values from the BM25 literature. **Adopted, not tuned
  against this corpus.** That distinction is the point: they are defensible because they are
  the standard, and a number tuned until the demo looked good would not be.

Like both existing arms, this one repeats the `owner_sub` and `embedding_model` predicates in
its own SQL rather than trusting another arm to have applied them. Ownership belongs in the
same predicate as the search (CLAUDE.md §6), and a third query is a third place to forget it.
Filtering on the embedding model is not needed for a text match, but it keeps one rule across
the whole of retrieval and preserves the documented degradation: switching embedder yields
nothing at all, rather than an app that half-works on whichever questions happen to match
lexically. Both `df` and `avgdl` are computed within that same scope, so one user's corpus can
never influence another's ranking.

The arm returns at most `RAG_TOP_K` rows, as the other two do, and a question whose lexemes all
vanish to stopwords yields no rows and the arm contributes nothing.

- **Rejected:** ParadeDB / `pg_search`. A real BM25 index, and a new extension, a new base
  image, and a new way for `docker compose up` to fail offline — bought for a corpus of 53
  chunks that answers in 20 ms without it.
- **Rejected:** a maintained term-statistics table. It is a second write path that can drift
  from the content it describes, which is exactly what the generated column exists to prevent.

### 3.3 Admission by IDF coverage, not by a score floor

A BM25 score is unbounded and depends on the corpus it was computed over. A floor on it would
be the *"threshold invented for text ranks and tuned by feel"* that slices 10 and 13 both
refused, and it would put the refusal path on top of it.

Coverage is a different kind of number: the share of the question's total IDF mass that a chunk
accounts for. It is dimensionless, lies in [0, 1], and states something a person can check —
*this chunk accounts for at least half of what you actually asked about.* A query term the
corpus never contains counts in the denominator at maximum IDF, so asking about Peru lowers
coverage rather than being quietly ignored.

**Threshold: 0.5.** A constant in the module, not an environment variable — the same treatment
`K = 60` gets in `fuse.ts`. An env var here would be an invitation to tune the refusal path
until a demo passed.

Stated plainly, because it is the weakest joint in this design: 0.5 **is** a constant, chosen
to sit in the gap between 0.34 and 0.63 that this corpus happens to show. It refuses the vague
in-corpus question at 0.34. That is a new false refusal and it is written into Known gaps
rather than smoothed over.

### 3.4 Three arms, and fusion that still only orders

`fuseByRank` takes N ranked lists instead of exactly two. Its central claim is unchanged and
must stay true: **every list arrives already filtered in SQL, each by its own admission rule, so
fusion only orders and an empty result stays empty.** That is what keeps "Not found in your
knowledge base." reachable before any model call.

The prose arm runs on **every** question, like the identifier arm and unlike a rescue that
fires only when the vector arm came back empty. Gating one arm on another's outcome would make
retrieval depend on the order the arms are evaluated in and would cost `fuse.ts` its claim of
independent inputs.

`matchedBy` gains a third value. Nothing branches on it; it is recorded for the log.

### 3.5 `RAG_MIN_SCORE` is not changed

The README's roadmap made rethinking that floor a precondition for this work — *"that floor is
the thing currently holding the refusal path up."* The measurement says otherwise. The floor
goes on doing its job on the arm it was written for, and the prose arm brings an admission rule
of its own that needs no corpus tuning.

The roadmap was wrong, and the README should say so, the way slice 13 corrected gap 11's
justification rather than quietly building past it.

## 4. Acceptance

1. `docker compose up` on a fresh clone still works, migration included, no manual step.
2. The five measured false refusals return chunks, and the answering chunk is among them.
3. The six unanswerable questions still refuse, **with no model call** — verified by the audit
   table not growing.
4. The ten prose questions that already worked return results no worse than before. This is
   stated as an acceptance criterion, not checked afterwards: the arm runs on every question,
   so it can make things worse, and the before/after table is the evidence that it did not.
5. `npm test` and `npm run typecheck` pass.

**On testing.** The coverage arithmetic and term extraction get unit tests. The BM25 SQL
**cannot** be unit-tested here: the suite deliberately opens no database connection, which is
precisely how slice 13's `&&` operator-precedence bug reached the running stack past a green
suite. The controlling verification for this slice is therefore the probe re-run against the
running app, and that is a deliberate choice rather than a shortfall.

## 5. What this does not do

Written down now so it is not discovered later:

- **The 0.5 coverage constant is arbitrary in the way any threshold is.** It is derived from a
  measured separation on one corpus of 53 chunks, not from theory.
- **A vague question is now refused for a new reason.** *"what contradiction did I never get to
  the bottom of?"* has a 0.34 coverage and will not clear the bar, even though the corpus has a
  section headed *"unresolved contradiction"*.
- **`avgdl` is corpus-wide, so the query touches every one of the owner's chunks.** Fine at
  personal scale, and the same assumption README gap 6 already records for the documents list
  and for retrieval generally.
- **The prose arm is English-only,** now explicitly so, since it names the `english` text search
  configuration. The `simple` identifier arm remains language-neutral.
- **Stemming does not fix vocabulary mismatch.** A question sharing no word stem with the note
  that answers it is still the vector arm's problem alone.

## 6. Files

| File | Change |
| --- | --- |
| `src/server/db/schema.ts` | `contentTsvEn` generated column + GIN index |
| `src/server/db/migrations/0006_chunks_fts_english.sql` | new |
| `src/server/rag/bm25.ts` | new — the BM25 + coverage SQL, and the constants, in one place |
| `src/server/rag/retrieve.ts` | third arm |
| `src/server/rag/fuse.ts` | N lists instead of two; third `matchedBy` value |
| `test/bm25.test.ts`, `test/fuse.test.ts` | coverage arithmetic, N-way fusion |
| `README.md` | retrieval section → three arms; gap 12 narrowed; roadmap item 2 closed and its precondition corrected; new gaps |
| `docs/decisions.md` | one line per decision above |

---

## 7. Deviations, as built

Three things in the design above did not survive contact with the measurement. Recorded here in
the convention `docs/implementation-plan.md` uses, rather than edited into §3 as though they had
always been the plan.

**Deviation, as built (§3.1): `content_tsv_en` has NO GIN index.** The column ships as designed
in every other respect. The index does not, because the arm has no use for one: BM25 needs
corpus-wide statistics — `N`, `avgdl` and `df` — so §3.2's query reads every one of the owner's
chunks whatever it does, and it never issues the `@@` match a GIN index exists to serve. An index
would be storage and a write cost buying nothing measurable. `EXPLAIN (ANALYZE)` over the seed
corpus puts the query at 7.3–7.9 ms, all buffers cached, down from the 19.9 ms §2 measured before
the stored column existed. Written into the README as gap 21.

**Deviation, as built (§3.3): admission is `coverage >= 0.5` AND at least two distinct matched
query lexemes.** The second condition is not in the design. It was added after review found that
coverage alone saturates, which the separation table in §2 could not show because every question
in it is a full sentence. Coverage is a *share* — it divides by the question's own IDF mass, so
that mass cancels and never reaches the test, and a question reducing to one content lexeme scores
1.000 against every chunk containing it. Measured on the same corpus: `notes` admitted a full page
of six rows with 31 of 53 chunks qualifying, `power` with 18 of 53, and *"what happened?"*, *"is it
good?"* and *"what year is it?"* each did the same at coverage 1.000. That is not a ranking
problem. §3.4's guarantee is that an empty retrieval is what produces "Not found in your knowledge
base." before any model call, so a vacuous question would have reached the model and the refusal
would have rested on the model obeying its prompt — the outcome §3.3 exists to prevent. Two
distinct terms closes it, needs no new tunable, and is checked in the same SQL predicate as
ownership. After the change all five short questions return nothing and none of the five questions
this slice targets regressed. Consequence, written into the README as gap 20: a genuine
single-content-word question now gets no prose arm at all and falls back to the vector arm alone.
Any separation figure quoted from §2 must therefore be read as scoped to full-sentence questions,
which is the population it was measured over.

**Deviation, as built (§4, "On testing"): `bm25.ts` has no unit test.** §4 said the coverage
arithmetic and term extraction would get unit tests. Neither exists as TypeScript to test: every
branch of the rule — coverage, the term count, the admission predicate, the ordering — is inside
the query, and the suite deliberately opens no database connection, which is precisely how slice
13's `&&` operator-precedence bug reached the running stack past a green suite. A TypeScript
reimplementation would test the copy rather than the query, and would have gone green in exactly
that scenario. The controlling verification is therefore the measured pass against the running
app that §4 already named as this slice's controlling evidence: the five recovered questions, the
ten unchanged ones, and six refusals with the audit table not growing. The residual risk — a
future edit to the SQL breaks retrieval, and only another manual pass catches it — is written into
the README as gap 23.
