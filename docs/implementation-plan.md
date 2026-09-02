# Implementation plan

`CLAUDE.md` §4 is the design and §8 is the slice order. This file covers **only what
`CLAUDE.md` leaves open or gets wrong**, so it is short on purpose. Read it alongside
`CLAUDE.md`, not instead of it.

## 1. Correction to CLAUDE.md §5 — embeddings

**Anthropic does not offer an embeddings endpoint.** Their docs say so plainly and point at
Voyage AI instead. The `LlmProvider` interface in §5 therefore cannot be implemented by the
`anthropic` provider as written: `embed()` has nothing to call.

The seam splits in two. Two external concerns, two interfaces, each selected by its own env
var:

```ts
// src/server/ai/types.ts
export interface LlmProvider {
  readonly name: string;
  answer(input: AnswerInput): Promise<AnswerResult>;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;      // stored per chunk; see §3
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}
```

| Interface | Env var | Implementations |
| --- | --- | --- |
| `LlmProvider` | `LLM_PROVIDER` | `anthropic` \| `gateway` \| `mock` |
| `EmbeddingProvider` | `EMBEDDING_PROVIDER` | `local` \| `mock` |

This is a stronger answer, not a weaker one: the hard requirement is that LLM calls sit
behind a swappable abstraction, and there are demonstrably two different external services
here. Collapsing them into one interface would have hidden that.

## 2. Embeddings run locally, in-process

`local` uses `@huggingface/transformers` (v4.2.0 — note the package moved from
`@xenova/transformers`) with `Xenova/all-MiniLM-L6-v2`, 384 dimensions, mean pooling,
normalised.

Two things follow, and both are README material:

- **No text leaves the process to be embedded.** Only the answer step crosses a network
  boundary, and that text is anonymised first. This materially lowers the data-protection
  profile argued in the classification section.
- **The model is baked into the image at build time.** `env.localModelPath` plus
  `env.allowRemoteModels = false` means the running container never reaches the Hugging Face
  Hub, so `docker compose up` works with no network and cannot fail on a Hub outage. A
  runtime download would have violated the zero-manual-steps requirement the first time
  someone ran it on a bad connection.

Cost: roughly 25 MB of model in the image and a one-off load on first embed. Both acceptable.

## 3. Embeddings are model-specific — store the model id

Vectors from two different models are not comparable. Switching `EMBEDDING_PROVIDER` against
an existing database would silently return nonsense rankings rather than an error.

So `chunks` carries an `embedding_model` column, and the retrieval SQL filters on the active
provider's model id alongside the ownership filter. Changing embedder means re-embedding, and
the app tells you that instead of quietly degrading.

## 4. The mock embedder must actually retrieve

`docker compose up` with no API key has to give a working demo. Random vectors would score
below `RAG_MIN_SCORE` on every query, the citation guard would correctly reject every answer,
and every question would come back "Not found in your knowledge base." — a broken-looking app
that is technically behaving correctly.

`mock` therefore hashes tokens into a 384-dimensional vector and normalises it: about 30
lines, deterministic, no network, and it behaves like keyword search. Good enough to retrieve
the right chunk for a demo question. The README says plainly that mock mode degrades semantic
search to lexical matching. It is also what the unit tests use, since it needs no model load.

## 5. Known risk: the Keycloak issuer mismatch

The browser is sent to `http://localhost:8080`; the app container resolves Keycloak at
`http://keycloak:8080`. The `iss` claim then fails validation and sign-in breaks. This is the
most likely place slice 2 overruns its 1.5 h.

Timeboxed to 30 minutes, in this order:

1. Pin Keycloak's frontend URL (`KC_HOSTNAME`) so the issuer string is identical from both
   sides, and give the app container a matching alias.
2. If that fights the container network, proxy Keycloak under the Next.js origin so both
   sides see exactly one issuer.

If both fail inside the timebox: document it, and fall back to whatever produces a working
sign-in, with the compromise written into README → *Known gaps*.

## 6. Versions (pinned, from the registry on 2026-08-26)

| Package | Version | Note |
| --- | --- | --- |
| `next` | 16.3.3 | App Router |
| `next-auth` | 5.0.0-beta.32 | v5 is still beta — see decisions log |
| `drizzle-orm` / `drizzle-kit` | 0.45.2 / 0.31.10 | |
| `@huggingface/transformers` | 4.2.0 | local embeddings |
| `pino` | 10.3.1 | |
| `zod` | 4.4.3 | |
| `pg` | 8.23.0 | |

Postgres image: `pgvector/pgvector` (Postgres 17). Keycloak: current stable, realm imported
from `infra/keycloak/realm.json`.

## 7. Env vars — the full set

Every one of these goes in `.env.example`, the zod env schema, and the README together.

```
DATABASE_URL
OIDC_ISSUER  OIDC_CLIENT_ID  OIDC_CLIENT_SECRET  OIDC_SCOPES  OIDC_ROLES_CLAIM
AUTH_SECRET  AUTH_URL
LLM_PROVIDER  LLM_MODEL  ANTHROPIC_API_KEY  LLM_GATEWAY_BASE_URL  LLM_GATEWAY_API_KEY
EMBEDDING_PROVIDER  EMBEDDING_MODEL
RAG_MIN_SCORE  RAG_TOP_K
RETENTION_AUDIT_DAYS  RETENTION_LOG_DAYS
```

**Deviation, as built:** `RETENTION_LOG_DAYS` was NOT implemented, and `LLM_TIMEOUT_MS` and
`EMBEDDING_CACHE_DIR` were added. Application and auth logs go to stdout — this process never
stores them, so it cannot purge them, and shipping a variable that does nothing would have
been worse than not having one. The reasoning is in the README's retention section, stated as
an interpretation rather than guessed silently.

## 8. Slice order

Unchanged from `CLAUDE.md` §8, with the corrections above folded in. Slice 3 gains the
`embedding_model` column and the local embedder; slice 4 loses `embed()` from `LlmProvider`.

Seed data (slice 3's input) is already done: 10 synthetic documents in `seed/`.

## 9. Open item — CLOSED

`CLAUDE.md` §5 has since been corrected to show the two split interfaces, so this plan and
the governing spec agree. §1 above is kept as the record of *why* they differ from the
original brief, which is the part worth explaining.

Two further items were raised here against `CLAUDE.md`:

- **§10 labelled the classification a draft.** *Resolved 2026-09-02:* §10 is now settled to
  **MEDIUM** and points at the README, which holds the nine-criteria argument.
- **§8's slice timings** were written before the build, and are left that way on purpose. What
  actually happened, and what was cut, is in the README under *Known gaps*.
