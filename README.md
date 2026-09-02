# Personal knowledge base

A signed-in user uploads notes and documents, asks questions in natural language, and gets an
answer that **always** points back to the source document. If nothing in their own notes
answers the question, the app says so instead of guessing.

A portfolio project. It is deliberately small in feature count and deliberately
production-shaped everywhere else: OIDC identity, server-side authorization, a swappable
model provider, anonymization in both directions, an audit log that stores no content, and
retention that is enforced by a job rather than described in a document. The build was
timeboxed to about eight hours on purpose — long enough to make every one of those claims
real, short enough that the interesting decisions are about what to leave out. What that
cost is written down under [Known gaps](#known-gaps-and-deliberate-debt).

Everything in `seed/` is synthetic — the people, e-mail addresses and phone numbers in it
are invented.

---

## Run it

```bash
git clone https://github.com/JimBimCZ/secure-llm.git
cd secure-llm
cp .env.example .env
docker compose up
```

That is the whole procedure. No API key, no model download, no migration step, no seeding
step. First build takes a few minutes because the embedding model is baked into the image;
afterwards the container needs no network at all.

When the logs settle, open **http://localhost:3000** and sign in:

| User | Password | Roles |
| --- | --- | --- |
| `alice` | `alice` | `user` |
| `admin` | `admin` | `admin`, `user` |

The first sign-in loads ten synthetic documents (53 chunks) into that user's knowledge base,
so there is something to search immediately. Signing in again does not duplicate them.

Health at **http://localhost:3000/api/health** — process status plus a real database round
trip, not a hard-coded `{"ok":true}`.

### Running with a real model

The default answers without an API key (see [Answering](#answering-three-routes-and-a-mock)).
For the real run, pick a route and set its key in `.env`:

```bash
# Through OpenRouter (a third-party AI gateway)
LLM_PROVIDER=openrouter
LLM_MODEL=anthropic/claude-opus-5
OPENROUTER_API_KEY=sk-or-v1-...

# …or straight at the vendor
LLM_PROVIDER=anthropic
LLM_MODEL=claude-opus-5
ANTHROPIC_API_KEY=sk-ant-...
```

then `docker compose up -d --build app`. **That is the entire difference** — same prompt, same
citation guard, same anonymizer, same audit record; only the model id namespace changes.

Selecting a provider without its key **refuses to start** rather than silently falling back —
an app that quietly stops using the model you configured, and answers differently because of
it, is worse than one that will not boot.

---

## What to try

Seven things, each demonstrating one of the commitments above. Every one of these was run against
a fresh `git clone` before this README was written.

1. **A cited answer.** Ask *"How should I size a power supply for a high-end GPU build?"*
   Every answer carries numbered source links. Click one: it opens the source document
   scrolled to the exact passage, highlighted.
2. **The citation guarantee.** Ask *"What is the best recipe for sourdough bread starter?"*
   The corpus cannot answer it, so the app returns **"Not found in your knowledge base."**
   and never calls the model at all.
3. **Anonymization, outbound.** Ask *"What did Marek Dvorak say about the RAM kit?"* Expand
   **"N values redacted before this left the app"**: it shows the question exactly as it was
   sent — `What did [PERSON_1] say about the RAM kit?`
4. **Anonymization, inbound.** Ask *"Who should I contact about the CAKE configuration on my
   router?"* The panel reports that a name, an e-mail and a phone number were redacted before
   the call, and the answer above it reads *"David Kraus (david.kraus@example.com,
   +420 603 456 789) set up the CAKE configuration…"* — restored on the way back.
   (This answer also shows the PDF word-splitting artifact in gap 5: `configur ation`.)
5. **Server-side authorization.** Signed in as `alice`, open
   http://localhost:3000/api/admin/stats → **403 `{"error":"insufficient role"}`**, from the
   server, with no UI involved. Signed in as `admin` → 200. Nothing is hidden in the browser;
   the guard is the control.
6. **Retention, enforced.** Set `RETENTION_AUDIT_DAYS=0`, restart, and watch the log line
   `{"table":"llm_calls","purged":N,"msg":"retention purge"}` and an empty table. Set it back
   to 30.
7. **Delete my account.** On the home page. Wipes every document, chunk and embedding
   belonging to that subject, immediately. The other user's data is untouched, and signing
   back in re-seeds a fresh corpus.

Two of these depend on the mock answerer picking particular sentences. With a real model
(`LLM_PROVIDER=openrouter` or `anthropic`) the answers are better written — item 4 comes back
as *"You should contact David Kraus for the CAKE configuration on your router…"* rather than a
lifted sentence — but the citations, the refusal and the redaction behave identically. Those
are enforced by the app, not by the model.

---

## How it works

```
question
   │
   ├─ 1. embed the question in-process ─────────────► no network
   ├─ 2. vector search: owner + embedding model + score floor, all in ONE SQL predicate
   │       └─ nothing clears the floor? → "Not found in your knowledge base." (no model call)
   ├─ 3. anonymize the question and every retrieved chunk ──► [PERSON_1], [EMAIL_1], [PHONE_1]
   ├─ 4. one model call, through one wrapper that times out and writes the audit record
   ├─ 5. CITATION GUARD: every cited number must index the set we sent
   │       └─ none survive? one stricter retry, then "Not found in your knowledge base."
   └─ 6. restore the placeholders, return answer + sources
```

### The two seams

Answering and embedding are two different external concerns, so they get two interfaces.
**Anthropic does not offer an embeddings endpoint** — their documentation says so and points
at Voyage AI — so a single combined interface could not be implemented by the `anthropic`
provider at all. Merging them would have hidden a second vendor inside a file named after
the first.

| Interface | Env var | Implementations |
| --- | --- | --- |
| `LlmProvider` | `LLM_PROVIDER` | `anthropic` · `openrouter` · `gateway` · `mock` |
| `EmbeddingProvider` | `EMBEDDING_PROVIDER` | `local` · `mock` |

Nothing outside `src/server/ai/providers/` knows about HTTP, headers or vendor JSON. Model
ids come from the environment, never from a call site.

### Answering: three routes and a mock

- **`anthropic`** — the vendor's API directly, through the official SDK.
- **`openrouter`** — a **real, third-party AI gateway**, and the reason the seam is
  demonstrated rather than asserted. OpenRouter is a different company, a different account,
  a different billing relationship and a different model namespace, and reaching it required
  no change to the prompt, the request, the parsing, the citation guard, the anonymizer or
  the audit record. The provider file is nine lines of configuration. That is the same
  argument a corporate AI Gateway would need, made against something that actually exists.
- **`gateway`** — the generic form, for any other Anthropic-compatible gateway (LiteLLM,
  Azure API Management and similar): you supply the base URL and the credential, and it
  authenticates with `Authorization: Bearer` rather than `x-api-key`, because a gateway
  authenticates the *caller* against itself, not against the vendor. It shares its entire
  call path with `openrouter`, so the pattern is exercised even though this particular file
  is configured rather than run.
- **`mock`** — the default, so the app is fully demoable with no API key. It does **not**
  generate. It scores every sentence in the retrieved chunks against the question and
  returns the best few verbatim, citing the chunks they came from. Retrieval, the citation
  guard and the source links are all genuinely exercised. What it cannot do: synthesise
  across two documents, resolve a pronoun, or rephrase. That is the honest cost of a demo
  that needs no key.

### Embedding: in-process, by default

`local` runs `Xenova/all-MiniLM-L6-v2` inside the Node process via `@huggingface/transformers`.
**No text ever leaves the process to be embedded** — only the answering step crosses a
network boundary, and that text is anonymised first. This materially lowers the
data-protection profile argued in [Classification](#classification-medium).

The model is baked into the image at build time with remote fetching disabled, so the
container never contacts the Hugging Face Hub and `docker compose up` works offline.

`mock` is the alternative: a deterministic hashing embedder with no model and no network,
used by anything that cannot load onnxruntime. It degrades semantic search to lexical
matching — it matches on shared vocabulary and knows nothing about meaning — so it is a test
and fallback path, **not** the demo path. `local` is the default, needs no API key, and is
baked into the image, so `docker compose up` gives real semantic retrieval.

Vectors from different models are not comparable, so every chunk records the
`embedding_model` that produced it and retrieval filters on the active one. Changing the
embedder degrades to "no results", never to silently wrong rankings.

### Chunking is dictated by the model, not by taste

`all-MiniLM-L6-v2` accepts 512 tokens and **silently truncates** beyond that — text past the
cut is stored and citable but invisible to retrieval, which looks like poor recall and is
very hard to spot. At the original ~800-token target, 32 of 40 chunks overran it: roughly a
third of every document was invisible. After resizing to ~500 tokens (budgeted
pessimistically at 3 characters per token), 0 of 53 chunks truncate and top similarity rose
from 0.44 to 0.51.

---

## Models used

| Role | Model | Version / id | Where it runs |
| --- | --- | --- | --- |
| Answering | Claude Opus 5 | `claude-opus-5` (vendor) / `anthropic/claude-opus-5` (OpenRouter) | Anthropic API or OpenRouter, via `@anthropic-ai/sdk` 0.120.0 |
| Answering, as actually exercised | GPT-4o mini | `openai/gpt-4o-mini` | OpenRouter, via the same client |
| Embedding | all-MiniLM-L6-v2 | `Xenova/all-MiniLM-L6-v2`, `q8` weights, 384 dims | in-process, in the container |

The second row is the honest one, and it is worth a sentence. The live run of the answering
path was made through OpenRouter against **an OpenAI model**, using the Anthropic SDK, with
no change to the prompt, the request, the parsing, the citation guard, the anonymizer or the
audit record — the audit row reads
`provider=openrouter model=openai/gpt-4o-mini input_tokens=680 output_tokens=41 outcome=ok`.
A vendor swap that crosses model *families* and still touches nothing outside
`providers/openrouter.ts` is a stronger statement about the seam than a swap between two
routes to the same model would have been.

The `q8` (8-bit) weights are used rather than float32: 23 MB in the image instead of 96 MB,
identical 384 dimensions, and measured separation held (related pair 0.339 vs unrelated
−0.015).

**There is no speech-to-text**, because nothing here needs it. Were it added, it would be a
third interface beside the two above, selected by its own environment variable, for exactly
the same reasons.

---

## How this was built

This application was written with an AI coding agent, and the method is part of what the
project is meant to show. The brief that governs the build lives in
**[`CLAUDE.md`](./CLAUDE.md)** in the repository root. It is not a souvenir of the first
prompt — it is the living specification, corrected as the build found things the original
brief got wrong (most notably that Anthropic has no embeddings endpoint, which split one
interface into two). `docs/implementation-plan.md` records what the brief left open, and
`docs/decisions.md` records every decision taken since, with what was rejected and why.

**Written with:** Claude Opus 5 (`claude-opus-5`), via Claude Code.

The operative brief, condensed:

> Build a small but production-shaped personal knowledge base. A signed-in user uploads notes
> and documents, asks questions in natural language, and gets an answer that always points
> back to the source document.
>
> **Prime directive: never write code you would not be able to defend out loud.** Prefer
> boring, explicit, readable code over clever abstractions. One concept, one file, obvious
> name. Every non-trivial decision gets one line in `docs/decisions.md` recording the decision,
> the why, and what was rejected.
>
> Sign-in via OIDC only, no users/passwords table; swapping the IdP for Microsoft Entra ID
> must be configuration only. No MFA in the app. Two roles, enforced server-side in one shared
> guard on every endpoint.
>
> No direct call to a public AI API outside the provider folder; a corporate AI Gateway must be
> a new provider file plus an env var. API keys from env only. Synthetic data only.
> Anonymization is mandatory and must be visible in both directions. Retention implemented,
> not just documented. The LLM call log records model, timestamp, tokens, latency and outcome —
> never the prompt, never the answer, never document content.
>
> `docker compose up` brings up everything, including the mock IdP and the database, with
> schema migrated and seed data loaded, in zero manual steps. The app must start and be fully
> demoable with no API key set.
>
> The one functional promise: **an answer without a source is not shipped.** If the citations
> are empty, or any citation is not in the retrieved set, or the best similarity is under the
> floor, show "Not found in your knowledge base." One stricter retry is allowed, then stop.
>
> Timebox: 8 hours. When a task threatens it, cut scope and write the cut into the README
> under *Known gaps*. An honest gap is worth more than a half-finished feature.

Prompts sent to the model are **not** in this README and not in the TypeScript. They are files
in [`prompts/`](./prompts), loaded from disk at runtime, so anyone can read exactly what the
model was told without reading any code, and editing a prompt is not a code change.

---

## Identity

Sign-in is OIDC only. **There is no users/passwords table and there never will be.** The
`users` row is a local projection of the IdP subject — `sub`, display name, and a role
snapshot for display — and holds no credentials.

Roles come from a token claim on **every request**, never from the database. Revoking a role
at the IdP therefore takes effect on the next token, with no write to our database. The
snapshot exists for display and for the admin count; it is never the source of truth.

Authorization lives in one guard (`src/server/auth/guard.ts`) that **throws**, with a matching
`authErrorResponse()`. Route handlers stay three lines long and cannot accidentally return 200
when the guard rejects. Hiding a button in the UI is decoration; this is the control.

### Swapping the IdP for Microsoft Entra ID

Configuration only. No provider name appears anywhere in the code — even the Auth.js provider
id is `oidc`, not a vendor name, because that id appears in the callback URL
(`/api/auth/callback/oidc`) and naming it after the vendor would hard-code the vendor into a
URL registered at the IdP.

Change these five values and delete one:

```diff
- OIDC_ISSUER=http://localhost:8080/realms/pkb
+ OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
- OIDC_CLIENT_ID=pkb-app
+ OIDC_CLIENT_ID=<application (client) id from the Entra app registration>
- OIDC_CLIENT_SECRET=local-dev-only-change-me-client-secret
+ OIDC_CLIENT_SECRET=<client secret from the Entra app registration>
- OIDC_SCOPES=openid profile email
+ OIDC_SCOPES=openid profile email                      # unchanged for Entra ID
- OIDC_ROLES_CLAIM=roles
+ OIDC_ROLES_CLAIM=roles                                # Entra app roles land in `roles`

- OIDC_INTERNAL_ORIGIN=http://keycloak:8080             # delete this line entirely
```

`OIDC_INTERNAL_ORIGIN` exists only because a mock IdP on a container network is reachable at a
different address than the browser uses. Against a public IdP both are the same and the
variable is unset, at which point the fetch hook it drives becomes a plain `fetch`.

On the Entra side: register the app, add the redirect URI
`https://<your-host>/api/auth/callback/oidc`, define two app roles (`user`, `admin`), assign
them, and ensure the roles claim is emitted. Discovery is automatic from
`OIDC_ISSUER/.well-known/openid-configuration`.

Then remove the `keycloak` service from `docker-compose.yaml`. No application code changes.

### Why there is no MFA in this application

**MFA is an authentication-strength property owned by the identity provider**, and in an Entra
ID tenant it is enforced by Conditional Access policy, not by individual applications.

Implementing it here would be actively harmful, for three reasons:

1. **It would split the security control.** Two systems would each hold part of the
   authentication decision, and the app's half would not be visible to the tenant's security
   team, its policies, its reporting, or its audit.
2. **It would bypass tenant policy.** Conditional Access decides *when* a second factor is
   required — risk level, device compliance, location, session age. An app-level check knows
   none of that and would either over-prompt or under-protect.
3. **It would make this app a credential-handling system.** Right now it never sees a
   password, never stores a secret belonging to a person, and never enrols a factor. Adding
   MFA would drag TOTP seeds or phone numbers into scope, which is precisely the
   responsibility the IdP exists to absorb.

The app's job is to trust the token and enforce authorization. That is what it does.

---

## Privacy

### Anonymization

Before any text leaves the process toward a model, e-mails, phone numbers and person names
are replaced with stable placeholders — `[PERSON_1]`, `[EMAIL_1]`, `[PHONE_1]` — and the
inverse mapping is applied to the model's answer before the user sees it. Both directions are
visible in the UI, not just in the logs.

Two design points worth knowing:

- **One anonymizer instance per request.** It holds the only mapping that can turn
  `[PERSON_1]` back into a person, so it lives in memory for the life of one request and is
  never persisted, never logged, and never sent to the browser. Only counts and the
  already-redacted text reach the UI.
- **The same instance redacts the question *and* every chunk.** One value therefore gets one
  placeholder everywhere, which is what keeps a question about a person matching a chunk about
  them — both now read `[PERSON_1]`. Independent anonymizers would have numbered them
  differently and quietly broken the connection.

Retrieval runs on the **original** text: embeddings are computed in-process so nothing leaves
to be embedded, and searching redacted text would mean searching for placeholders rather than
for what the user actually asked about.

### What the detector actually does, measured

It is regexes plus a name dictionary plus a capitalised-bigram heuristic, and it is meant to
be read in one sitting and argued with. A naive detector whose limits are written down beats
a black box whose limits are not. Measured against the full seed corpus:

| | Detected | Leaked |
| --- | --- | --- |
| People | 6 / 6 | 0 |
| E-mail addresses | 6 / 6 | 0 |
| Phone numbers | 3 / 3 | 0 |

Round trip is byte-identical. There are **6 false positives** — `Arrow Lake`, `Curve
Optimizer`, `Adaptive-Sync`, `Ultra High`, `Display Stream`, `Wi-Fi` — so **precision on
person detection is 50%** while recall on the values that matter is 100%.

That bias is deliberate. A false positive means the model reasons over an opaque token and
`restore()` puts the real text back, so **the user never sees a difference**. A false negative
is a leak. The detector is tuned to over-redact.

**Known limits, all of them deliberate:**

- It cannot tell a person from any other two-word proper noun.
- A single unknown first name on its own ("ask Petra") is missed unless it is in the dictionary.
- Addresses, dates of birth, national ID and account numbers are **not detected at all**.
- The dictionary is a constant here because the corpus is synthetic and eight names is the
  whole population. In a real deployment it would come from wherever the organisation already
  keeps its people — a directory export, an HR system — refreshed on a schedule. The
  anonymizer takes the list; it does not own it.

### The LLM call log

One row per call that left the process, holding **exactly** this and nothing else:

`provider · model · input tokens · output tokens · latency · outcome · timestamp`

No prompt, no answer, no document text — the table has nowhere to put them even by accident.
And deliberately **no subject**: the record exists to answer *"what did this app spend and how
did it behave"*, not *"what did this person ask"*. Adding the subject would quietly turn a
cost-and-latency table into a 30-day behavioural log of every user, which is a different thing
needing a different justification. Failed calls are recorded too, with zero tokens and outcome
`timeout` or `error`, because a call that was made and failed still consumed a deadline.

Errors are audited by the error's **class name**, never its message: a provider error can echo
the request back, and the request contains the user's own notes.

### Retention

Implemented in `src/server/retention/purge.ts`, run on startup and then hourly.

| Data | Retention | Deletion |
| --- | --- | --- |
| Documents, chunks, embeddings | Until the user deletes them | Immediate hard delete on request, cascading to chunks and embeddings |
| LLM audit records | `RETENTION_AUDIT_DAYS`, default 30 days | Hourly purge job |
| Anonymization mapping | The lifetime of one request | Never persisted — there is nothing to delete |
| Prompt content, answers, document text in logs | Never stored | n/a |
| Application and auth logs | Not stored by this process | See the note below |

**Application and auth logs go to stdout.** This process never stores them, so it cannot purge
them, and there is deliberately no `RETENTION_LOG_DAYS` variable — shipping a setting that
does nothing would be worse than not having one. Retention there belongs to whatever collects
the container's output (Docker's logging driver, or your log platform's policy). This is an
interpretation of an ambiguous requirement, stated here rather than guessed silently.

"Delete my account" wipes every row belonging to the subject. It takes no parameter — the
subject comes from the guard — so the endpoint cannot be pointed at anyone else's data.

---

## Secrets and data handling

- `.env` is git-ignored; `.env.example` is committed with every variable. `git log -p`
  contains no secrets.
- **The committed values are working local-development credentials, not inert
  placeholders**, and the file says so at the top. They have to work: `cp .env.example .env
  && docker compose up` must bring the stack up with no manual step, so a value that needed
  editing first would break the one-command promise this README opens with. They are safe to commit only
  because everything they unlock is a container on the reader's own machine. All five are
  spelled `local-dev-only-change-me-*`, so one `grep` finds anything still at its default,
  and the header lists what to regenerate before this runs anywhere else.
- Two of them are **coupled to a second file**, and `.env.example` marks both: the Postgres
  password is repeated inside `DATABASE_URL`, and `OIDC_CLIENT_SECRET` must match the client
  secret in `infra/keycloak/realm.json`. Nothing validates either pair, and changing one half
  produces an error that points at neither line.
- `AUTH_SECRET` is called out separately because it is not the same kind of secret as the
  rest. The others gate a local container; that one signs and encrypts the session cookie, so
  holding it means minting a valid session for any user without ever touching the IdP.
  Deployed with the committed value, the app would have no authentication at all.
- **Nothing fake is baked into the image either.** `next build` imports every route module,
  which reaches the environment schema; satisfying it in the Dockerfile would have meant
  putting six placeholder values, one of them named `OIDC_CLIENT_SECRET`, into an image layer
  of a repository that makes a point of secret hygiene. The build phase is detected and
  skipped instead,
  and the running server always validates for real at startup.
- Environment validation reports variable **names** only, never values — the offending value
  may itself be a secret, and that message ends up in logs.
- The session cookie is `httpOnly`; no token is readable from JavaScript.
- The logger redacts `password`, `token`, `authorization` and `apiKey` at any depth.
- Only synthetic data is in the repository.

---

## Classification: MEDIUM

Any risk classification is only as good as the criteria behind it, and there is no single
standard matrix, so the criteria used here are stated explicitly rather than implied.
**If your organisation's matrix defines the levels differently, follow that one and keep the
reasoning structure.**

| Criterion | Assessment | Pushes toward |
| --- | --- | --- |
| Personal data processed | Yes — user documents can contain names, e-mails, phone numbers | **MEDIUM** |
| Data leaves the organisation | Yes — derived text goes to an external model (anonymised first; embeddings never leave) | **MEDIUM** |
| Special-category data | No, and not by accident: the corpus is synthetic and the app is for personal notes | not LARGE |
| User population | One user's own material; no shared or company-wide corpus | not LARGE |
| Business process criticality | Holds no company-critical process | not LARGE |
| Integrations into production systems | **None.** It reads nothing and writes nothing outside its own database | not LARGE |
| Impact of an outage | An inconvenience. Nobody is blocked; no process stops | not LARGE |
| Impact of a breach | Real but bounded: one person's notes | **MEDIUM** |
| Reversibility | High — documents are user-owned and can be re-uploaded | not LARGE |

**Verdict: MEDIUM.** It is above SMALL because it processes personal data and sends derived
text to an external model, which raises the data-protection profile above that of a trivial
internal tool. It is below LARGE because it serves a single user's own material, holds no
company-critical process, has no integrations into production systems, and an outage is an
inconvenience rather than an incident.

Two design choices lower the residual risk without removing it, and both are load-bearing in
this argument: **embeddings are computed in-process**, so the only text that ever crosses a
network boundary is the anonymised answering call; and **retention is enforced by a job**, not
merely described in this file.

If the anonymizer were removed, or if embeddings were sent to a third party, the honest
classification would move up.

---

## Configuration

Every variable is declared in one place (`src/server/env.ts`), validated with zod at startup,
and present in `.env.example`. Blank values are treated as unset, so an unset variable falls
back to its default rather than failing validation on an empty string.

| Variable | Default | What it does |
| --- | --- | --- |
| `DATABASE_URL` | — | Postgres connection string |
| `LOG_LEVEL` | `info` | `trace`…`fatal` |
| `AUTH_SECRET` | — | Session cookie encryption; `openssl rand -base64 32` |
| `AUTH_URL` | — | Public URL of the app |
| `OIDC_ISSUER` | — | Issuer as the **browser** sees it; lands in the token's `iss` |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | — | Client registration |
| `OIDC_SCOPES` | `openid profile email` | Requested scopes |
| `OIDC_ROLES_CLAIM` | `roles` | Which claim carries roles |
| `OIDC_INTERNAL_ORIGIN` | unset | Container-network address of the IdP. Unset for a public IdP |
| `EMBEDDING_PROVIDER` | `local` | `local` \| `mock` |
| `EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | Recorded on every chunk |
| `EMBEDDING_CACHE_DIR` | `./.models` | Where the baked-in model lives |
| `LLM_PROVIDER` | `mock` | `anthropic` \| `openrouter` \| `gateway` \| `mock` |
| `LLM_MODEL` | `claude-opus-5` | Model id **in the selected provider's namespace**; never hard-coded at a call site |
| `LLM_TIMEOUT_MS` | `60000` | Deadline for one call. The request is **aborted**, not abandoned |
| `ANTHROPIC_API_KEY` | unset | Required when `LLM_PROVIDER=anthropic` |
| `OPENROUTER_API_KEY` | unset | Required when `LLM_PROVIDER=openrouter` |
| `LLM_GATEWAY_BASE_URL` / `LLM_GATEWAY_API_KEY` | unset | Required when `LLM_PROVIDER=gateway` |
| `RAG_TOP_K` | `6` | Chunks put in front of the model |
| `RAG_MIN_SCORE` | `0.25` | Similarity floor; below it, "Not found in your knowledge base." |
| `RETENTION_AUDIT_DAYS` | `30` | Audit record lifetime. `0` purges everything on next run |

`RAG_MIN_SCORE` is measured, not guessed: answerable questions against the seed corpus score
0.363–0.586, and unanswerable ones (sourdough, tax returns, visa requirements) clear nothing
at all. 0.25 sits in that gap with headroom.

---

## Layout

```
prompts/                  *.md — every prompt, loaded from disk at runtime
seed/                     10 synthetic documents
src/
  app/                    routes; pages are thin, no business logic
    api/{health,documents,ask,me,admin}/
    ask/                  the one screen that matters
    documents/[id]/       source view, scrolled to the cited passage
  server/
    auth/                 session, requireUser(), requireRole()
    ai/
      types.ts            LlmProvider + EmbeddingProvider — the two seams
      call.ts             the ONLY door out of the process: timeout + audit
      providers/          anthropic · openrouter · gateway · mock  (answering)
      embedders/          local · mock                 (embedding)
    privacy/anonymizer.ts
    rag/                  chunk · extract · ingest · retrieve · answer · citations
    retention/purge.ts
    db/                   schema + migrations, applied on startup
    log/                  logger.ts, llmAudit.ts
test/                     node --test, no test dependency
docs/decisions.md         every "why exactly like this", one line each
docs/implementation-plan.md
```

## Tests

```bash
npm test          # 21 tests, node --test, no test framework
npm run typecheck
```

Two things are tested, and deliberately only two: **the anonymizer round trip** and **the
citation guard**. They are the two places where a silent failure is a correctness or privacy
incident rather than a visible bug. Coverage for its own sake was never the goal here, and
chasing it would have spent time the decisions log needed more.

The runner is Node's built-in one with a 25-line resolver hook, because the alternative was
either a test framework or reshaping the application's import style to suit a runner.

---

## Known gaps and deliberate debt

Written down rather than hidden. An honest gap is worth more than a half-finished feature.

1. **The `anthropic` provider has never been run against the live API.** There was no vendor
   key available during the build. What *has* been run live is everything the two providers
   share — `messages.ts`, the prompt, the JSON contract, the citation guard, the anonymizer
   round trip and the audit record — exercised through `openrouter` against a real gateway.
   What remains unexercised in `anthropic.ts` is the vendor client construction and the one
   branch `openrouter` deliberately does not take: `structuredOutputs: true`, where the API
   enforces the response schema server-side and fills `parsed_output` instead of leaving the
   JSON to be parsed out of the text. That branch is verified by construction, by typecheck
   against the current SDK, and by a startup check that refuses a keyless configuration — but
   unexercised is unexercised, and it is the first thing to run with a vendor key in hand.
2. **The `gateway` provider is configured but never pointed at a real gateway.** Its call
   path *is* exercised, because `openrouter` is the same path with the address filled in;
   what is untested is the generic form's own base-URL-plus-`Authorization: Bearer`
   construction, written against the common case where the gateway is Anthropic-API-compatible
   (LiteLLM, Azure API Management and similar all are). A proxy with its own wire format would
   be a different file implementing the same interface — which is the point, but it is an
   untested point.
3. **The citation guard's rejection branch is unreached in practice.** The
   *"no relevant sources"* refusal is reachable and demoed, but the branch that fires when a
   model cites outside the set it was given cannot be triggered by the mock, which never does
   that. It is covered by unit tests over `resolveCitations`, not end to end.
4. **Anonymization runs on the answering path only.** It is not applied at ingest, and it is
   not applied to filenames. Uploading a document named `notes-about-marek-dvorak.md` puts
   that name in the UI and in the source link. Deliberate — ingest-time redaction would make
   every stored document permanently lossy — but it is a real gap.
5. **PDF extraction occasionally splits a word across a line break**, producing
   `"configur ation"` in an answer. Cosmetic; it affects readability, never the citation.
6. **No pagination anywhere.** The documents list and retrieval both assume a personal-scale
   corpus. At a few thousand documents the list page would need it.
7. **The mock answerer cannot synthesise.** It extracts sentences. A question whose answer is
   spread across three notes gets the single closest passage, not a summary. Set
   `LLM_PROVIDER=openrouter` (or `anthropic`) for real synthesis.
8. **No rate limiting on `/api/ask`.** A signed-in user can spend money in a loop. In a real
   deployment this belongs at the gateway, which is one of the reasons corporate gateways
   exist — but saying so is not the same as having it.
9. **`users.role_snapshot` can go stale.** It is refreshed at sign-in and used only for
   display and the admin count. Authorization never reads it, so a stale value is cosmetic —
   but anyone reading the schema should know it is there and why it is not authoritative.
10. **The Keycloak realm uses `start-dev`.** Correct for a mock IdP, wrong for anything else.

## What I would build next

In this order, and for these reasons:

1. **Run the `anthropic` path end to end and re-measure.** Gap 1 above. Everything else is
   downstream of knowing the real path works.
2. **A better retriever.** Vector search alone misses exact-token queries — part numbers,
   error codes, `ddr5-6000`. Hybrid search (BM25 alongside vectors, fused) would fix a class
   of miss the current design cannot, and the seed corpus already shows it.
3. **Rate limiting and a per-user spend cap**, using the audit table that already exists.
4. **A stronger anonymizer, behind the same interface.** The current one is a regex detector
   honestly described. A NER model would raise precision above 50% without changing a single
   call site — the seam is already there.
5. **Re-embedding on model change.** Today, changing the embedder makes old chunks invisible
   and the app says nothing. It should detect the mismatch and offer to re-embed.
6. **Streaming answers.** Currently the user waits for the whole response. The citation guard
   has to run on a complete answer, so this needs care: stream the text, hold the sources
   until the guard has passed.
