# CLAUDE.md — Personal Knowledge Base (RAG with mandatory citations)

Instructions for Claude Code working in this repository. Read this before any change.

## 1. What this is

A small but production-shaped personal knowledge base. A signed-in user uploads notes and
documents, asks questions in natural language, and gets an answer that **always** points back to
the source document. It is a portfolio project: what matters is **how the work was done**,
not how much of it there is or how it looks.

Explicitly **out of scope**, so do not spend budget there: visual design, feature count, test
coverage, lines of code.

What the project stands or falls on, so spend budget here:

1. It runs on the first attempt by following the README (`docker compose up`, nothing else).
2. Every line of code and every design decision can be explained out loud.
3. README quality, including the classification of the app and its justification.
4. Clean handling of secrets and personal data.
5. Honest, written record of what was deliberately left undone.

**Timebox: 8 hours total.** When a task threatens it, cut scope and write the cut into
`README.md` → *Known gaps / deliberate debt*. Never silently skip a hard requirement in §3.

## 2. The prime directive

> Never write code you would not be able to defend out loud.

Consequences, in order of priority over everything else in this file:

- Prefer boring, explicit, readable code over clever abstractions. No metaprogramming, no
  dependency-injection frameworks, no code generation beyond the ORM client.
- One concept, one file, obvious name. If a reader has to jump through three files to see how a
  question becomes an answer, the design is wrong.
- Every non-trivial decision gets one line in `docs/decisions.md`:
  `YYYY-MM-DD — <decision> — <why> — <what was rejected>`. This file is the project's memory:
  it is where "why like this?" gets answered.
- No dead code, no commented-out experiments, no TODOs that are not also listed in the README.
- If a requirement is ambiguous, state the interpretation in the README rather than guessing
  silently.

## 3. Hard requirements (non-negotiable)

Treat each of these as a test. Any change that breaks one is a defect.

**Identity and access**

- Sign-in via OIDC/OAuth2 only. **There is no users/passwords table.** A `users` row may exist as a
  local projection of the IdP subject (`sub`, display name, role snapshot) — never credentials.
- Swapping the IdP for Microsoft Entra ID must be **configuration only**. That means: no provider
  name hard-coded anywhere, everything driven by `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
  `OIDC_CLIENT_SECRET`, `OIDC_SCOPES`, `OIDC_ROLES_CLAIM`. Discovery via
  `/.well-known/openid-configuration`. README must name the exact env vars that change for Entra ID.
- **No MFA logic in the app.** README explains why: MFA is an authentication-strength property owned
  by the IdP and enforced by Conditional Access policy; re-implementing it in the app would split
  the security control, bypass tenant policy, and make the app a credential-handling system.
- At least two roles: `user` and `admin`. Roles come from a token claim, not from the database.
  **Authorization is enforced server-side on every endpoint**, in one shared guard. Hiding UI is a
  cosmetic addition on top, never the control.

**LLM and data**

- No direct call to a public AI API anywhere outside `src/server/ai/providers/`. The rest of the
  codebase only knows the interfaces in §5. This is the single most important seam in the
  project: a corporate AI Gateway must be a new provider file plus an env var.
- API keys come from env vars only.
- Speech-to-text: not needed here. Say so in one line in the README.
- Only **synthetic data** in the repo (`seed/` folder). No real notes, no real names.
- **Anonymization is mandatory and must be visible.** Before any text leaves the process toward a
  model, names, e-mails and phone numbers are replaced with placeholders; after the model returns,
  the placeholders are restored. Both directions must be demonstrable in the UI.
- Retention must be **implemented, not just documented**: see §7.
- LLM call log records model, timestamp, token counts, latency, outcome. **Never the prompt,
  never the answer, never document content.**

**Operations**

- `Dockerfile` + `docker-compose.yaml`; `docker compose up` brings up everything, including the
  mock IdP and the database, with schema migrated and seed data loaded, with zero manual steps.
- No secrets in code, image, or repo. `.env` is local and git-ignored; `.env.example` is committed
  with every variable and a safe placeholder value.
- `GET /api/health` returns process + DB status.
- Structured logs for: startup, errors, sign-in, sign-out.
- Dependencies pinned; the lockfile is committed.

**Repository and documentation**

- Public Git repo, meaningful commit messages, small commits that tell the story of the work.
  The published history begins at this repository's initial commit; `docs/decisions.md` carries
  the reasoning that predates it.
- `README.md` covers: purpose, how to run, which model and version, the app classification
  (SMALL / MEDIUM / LARGE) **and the reasoning**, what would come next, what is deliberate debt.
- `prompts/` holds every prompt as a file. Prompts are **loaded from these files at runtime** — no
  prompt strings inline in TypeScript. The folder is the single source of truth.
- README has a **How this was built** section: the brief that generated the app, plus model
  name and version. Keep it updated as the brief evolves; it is part of the project, not a
  souvenir.

## 4. Stack and layout

Chosen for a TypeScript/React author, one language end to end, minimal moving parts.

- Next.js (App Router) + TypeScript, React Server Components for pages, Route Handlers for the API.
- Auth.js v5, generic OIDC provider configured purely from env.
- PostgreSQL + `pgvector`, accessed via Drizzle ORM; migrations checked in and run on startup.
- Keycloak as the local mock IdP, realm imported automatically from `infra/keycloak/realm.json`
  with two pre-seeded users (`alice` = user, `admin` = admin) and a `roles` claim mapper.
- `pino` for logs, `zod` for every boundary (env, request bodies, model JSON output).
- Tailwind for the UI. Plain, legible, no design system.

```
src/
  app/                  # routes; pages are thin, no business logic
    api/health/
    api/documents/
    api/ask/
  server/
    auth/               # session, requireUser(), requireRole()
    ai/
      types.ts          # LlmProvider + EmbeddingProvider — the two seams
      providers/        # anthropic.ts | gateway.ts | mock.ts        (answering)
      embedders/        # local.ts | mock.ts                          (embedding)
      index.ts          # factories driven by LLM_PROVIDER / EMBEDDING_PROVIDER
    privacy/anonymizer.ts
    rag/                # chunk.ts, embed.ts, retrieve.ts, answer.ts
    db/                 # schema.ts, migrations/
    log/                # logger.ts, llmAudit.ts
    retention/purge.ts
prompts/                # *.md, loaded at runtime
seed/                   # synthetic documents
docs/decisions.md
infra/keycloak/realm.json
```

## 5. The seams that matter: `LlmProvider` and `EmbeddingProvider`

**Anthropic does not offer an embeddings endpoint.** Their own documentation says so and points
at Voyage AI instead. Answering and embedding are therefore two different external concerns, and
they get two interfaces. Do not merge them back into one — a combined interface cannot be
implemented by the `anthropic` provider at all, and hiding a second vendor inside a provider named
after the first is exactly the kind of thing this split exists to prevent.

```ts
export interface LlmProvider {
  readonly name: string;
  answer(input: AnswerInput): Promise<AnswerResult>; // returns text + citations + usage
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;      // recorded on every chunk; see below
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}
```

| Interface | Env var | Implementations |
| --- | --- | --- |
| `LlmProvider` | `LLM_PROVIDER` | `anthropic` \| `gateway` \| `mock` |
| `EmbeddingProvider` | `EMBEDDING_PROVIDER` | `local` \| `mock` |

Rules that apply to both:

- Provider files are the only place that knows about HTTP, headers, or vendor JSON shapes.
- Model id lives in env (`LLM_MODEL`, `EMBEDDING_MODEL`), never hard-coded in call sites.
- **The app must start and be fully demoable with no API key set** so anyone cloning the repo
  without one still gets a working system. That is the acceptance test for both seams.
- Every call that leaves the process goes through one wrapper that writes the audit record (§3)
  and enforces a timeout.

`LlmProvider` implementations:

- `anthropic` — the real run.
- `gateway` — thin stub showing what a corporate AI Gateway swap looks like: different base URL,
  different auth header, same interface. This file is the argument that the abstraction is real.
- `mock` — deterministic, no network. Used by tests and whenever no key is set.

`EmbeddingProvider` implementations:

- `local` — the default and the real run. Runs the model **in-process** via
  `@huggingface/transformers`; no text leaves the process to be embedded, so only the anonymised
  answer call ever crosses a network boundary. The model is baked into the image at build time
  (`env.localModelPath`, `env.allowRemoteModels = false`) so the container never reaches the
  Hugging Face Hub and `docker compose up` works offline.
- `mock` — hashes tokens into a normalised vector of the same dimensionality. Deterministic, no
  model load, used by the unit tests. It must **actually retrieve**: random or constant vectors
  would score below `RAG_MIN_SCORE`, the citation guard would reject every answer, and the app
  would look broken while behaving correctly.

Because vectors from different models are not comparable, every chunk records the
`embedding_model` that produced it and retrieval filters on the active one. Changing the embedder
means re-embedding, and the app must say so rather than silently returning nonsense rankings.

## 6. Retrieval and the citation guarantee

The one functional promise of this app: **an answer without a source is not shipped.**

1. Ingest: accept `.md`, `.txt`, `.pdf`. Store the original text, chunk it, and keep
   `documentId`, `chunkIndex`, and character offsets for every chunk.
   **Chunk size is dictated by the embedding model's input window, not chosen freely.**
   `all-MiniLM-L6-v2` accepts 512 tokens and silently truncates past that, so anything larger
   is stored and citable but invisible to retrieval. Target ~500 tokens with ~100 overlap,
   budgeted pessimistically at 3 characters per token. Changing the embedding model means
   re-checking this number.
2. Retrieve: vector search over the signed-in user's own chunks only. Ownership is filtered in SQL,
   never in application code after the fetch.
3. Answer: the model receives numbered chunks and must return JSON
   `{ answer: string, citations: [{ chunkId, documentId }] }`, validated with zod.
4. **Guard:** if `citations` is empty, or any citation is not in the retrieved set, or the best
   similarity is under `RAG_MIN_SCORE`, the app does **not** show the answer. It shows
   "Not found in your knowledge base." One retry with a stricter instruction is allowed, then stop.
   A fabricated or missing citation is a bug, not a UX edge case.
5. The UI renders each citation as a link to the source document, scrolled to the cited chunk.

## 7. Privacy, anonymization and retention

**Anonymizer** (`src/server/privacy/anonymizer.ts`), deliberately simple and explainable:

- Detects e-mails and phone numbers by regex; person names from a seed dictionary plus a
  capitalised-bigram heuristic. Its limits are documented in the README — a naive detector honestly
  described beats a black box.
- Replaces with stable placeholders per request: `[PERSON_1]`, `[EMAIL_1]`, `[PHONE_1]`.
- The mapping lives **in memory for the duration of the request only** and is never persisted or
  logged.
- Applied to the user's question and to every retrieved chunk before they reach a provider; the
  inverse mapping is applied to the model's answer before it reaches the user.
- Unit-tested with round-trip cases. This and the citation guard are the only two things worth
  testing.

**Retention** — documented in the README *and* implemented in `retention/purge.ts`, run on startup
and then hourly:

| Data | Retention | Deletion |
| --- | --- | --- |
| Documents + chunks + embeddings | Until the user deletes them | Immediate hard delete on request, cascading to chunks and embeddings |
| LLM audit records (model, time, tokens) | 30 days | Purge job |
| Application / auth logs | 30 days | Purge job (stdout retention is the operator's concern — say so) |
| Anonymization mapping | Request lifetime | Never persisted |
| Prompt content, answers, document text in logs | Never stored | n/a |

"Delete my account" wipes all rows belonging to the `sub` and is demonstrable in the UI.

## 8. Working agreements for Claude

- Before coding a slice, restate in one sentence which hard requirement from §3 it satisfies.
- Build in vertical slices that keep the app runnable at every commit:
  1. skeleton + docker compose + health + logging (~1h)
  2. Keycloak OIDC + session + `requireRole` guard + two roles (~1.5h)
  3. document upload + chunking + embeddings + list/delete (~1.5h)
  4. ask endpoint + LlmProvider + citation guard + UI (~2h)
  5. anonymizer + audit log + retention purge (~1h)
  6. README, the governing brief, `prompts/`, decisions log, demo pass (~1h)
- Commit at the end of each slice. Conventional-commit prefixes, imperative mood, the *why* in the
  body when it is not obvious.
- Never invent an env var without adding it to `.env.example`, to the zod env schema, and to the
  README.
- Never add a dependency to solve something 30 lines of clear code solves. If a dependency is
  added, its reason goes in `docs/decisions.md`.
- Do not touch `.env`, do not print secret values into logs, terminal output, or error messages.
- When you hit the timebox on a slice, stop, and write the remainder into README → *Known gaps*.
  An honest gap is worth more than a half-finished feature.

## 9. Definition of done

- [ ] Fresh clone, `cp .env.example .env`, `docker compose up` → app, DB and IdP healthy, seed
      loaded, sign-in works, no manual step.
- [ ] Works end to end with `LLM_PROVIDER=mock` and with a real key.
- [ ] `admin`-only endpoint returns 403 for `user` when called directly with curl.
- [ ] Every answer in the UI carries at least one working source link; the "no relevant source"
      path is reachable and demoed.
- [ ] Anonymization round-trip visible in the demo.
- [ ] `git log -p` contains no secrets; `.env` is ignored.
- [ ] LLM audit table contains model/time/tokens and nothing else.
- [ ] README has: run instructions, model + version, how it was built, Entra ID swap section,
      MFA rationale, retention table, classification + reasoning, known gaps.
- [ ] `docs/decisions.md` covers every decision someone would ask "why like this?" about.
- [ ] 3–5 minute walkthrough recorded.

## 10. Classification: MEDIUM

**Settled: MEDIUM.** It processes personal data contained in user documents and sends derived
text to an external model, which raises the data-protection profile above a trivial tool; but it
serves a single user's own material, holds no company-critical process, has no integrations into
production systems, and an outage is an inconvenience rather than an incident. The anonymization
layer and the retention policy lower residual risk, they do not remove it.

The README's *Classification* section is the canonical wording: it argues the verdict against nine
named criteria and says which two design choices are load-bearing (in-process embeddings, enforced
retention). Keep the two in step. If a particular organisation's classification matrix defines the
levels differently, follow that matrix and keep the reasoning structure.
