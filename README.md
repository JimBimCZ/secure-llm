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

**Where things are.** This README is the tour. Three files carry the detail it summarises:

| | |
| --- | --- |
| [`docs/architecture.md`](./docs/architecture.md) | How retrieval, streaming, injection defence, the detector and the spend ceilings actually work, with the measurements |
| [`docs/known-gaps.md`](./docs/known-gaps.md) | All 42 gaps in full, including what the five closed ones corrected |
| [`docs/decisions.md`](./docs/decisions.md) | Every "why exactly like this", one line each, newest last |

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

The default answers without an API key (see [Answering](./docs/architecture.md#answering-three-routes-and-a-mock)).
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

Twelve things, each demonstrating one commitment. Items 1–2 and 4–8 were run against a fresh
`git clone` before this README was written; 3 and 9–12 against the same stack with the corpus
already loaded.

**The citation guarantee**

1. **A cited answer.** *"How should I size a power supply for a high-end GPU build?"* Every
   answer carries numbered source links; clicking one opens the source document scrolled to the
   exact passage, highlighted.
2. **A refusal.** *"What is the best recipe for sourdough bread starter?"* The corpus cannot
   answer it, so the app returns **"Not found in your knowledge base."** and never calls the
   model at all.
3. **The part number vector search gets wrong.** *"What are PL1 and PL2 set to?"* — the chunks
   that answer it score **0.054** and **0.063** against the 0.25 floor, so the vector arm alone
   would refuse. The exact match on `pl1`/`pl2` finds them and the answer comes back cited; the
   server logs `"lexicalHits":2`. Then *"What did I write about LGA 1718?"* — the same failure in
   two-token form, and sharper, because the corpus defines that socket in as many words and the
   best vector score is **0.236**. The pair `lga 1718` is searched as a phrase, and the citation
   lands on the line that defines it.
4. **The prose question vector search got wrong.** *"What is the arithmetic I actually use for
   sizing?"* was refused before the prose arm — best chunk **0.173** — from a document whose
   section is titled *"The arithmetic I actually use"*. It now answers, cited to
   `06-psu-sizing.md`, and the audit table grows by exactly one row. Asking *"notes"* on its own
   still admits **nothing**: one word is not a question.

**Privacy**

5. **Anonymization, outbound.** *"What did Marek Dvorak say about the RAM kit?"* Expand **"N
   values redacted before this left the app"** to see the question exactly as it was sent:
   `What did [PERSON_1] say about the RAM kit?`
6. **Anonymization, inbound.** *"Who should I contact about the CAKE configuration on my
   router?"* The panel reports a name, an e-mail and a phone number redacted before the call,
   and the answer above it reads *"David Kraus (david.kraus@example.com, +420 603 456 789) set
   up the CAKE configuration…"* — restored on the way back. (That sentence comes out of the seed
   PDF, whose layout splits words across lines; it reads `configuration` because extraction puts
   them back together — see gap 5.)
7. **Retention, enforced.** Set `RETENTION_AUDIT_DAYS=0`, restart, and watch
   `{"table":"llm_calls","purged":N,"msg":"retention purge"}` and an empty table. Set it back
   to 30.
8. **Delete my account.** On the home page. Wipes every document, chunk and embedding belonging
   to that subject immediately. The other user's data is untouched, and signing back in re-seeds
   a fresh corpus.

**Control**

9. **Server-side authorization.** Signed in as `alice`, open
   http://localhost:3000/api/admin/stats → **403 `{"error":"insufficient role"}`**, from the
   server, with no UI involved. As `admin` → 200. It also reports today's shared spend
   (`today.calls` against `today.limit`), because a ceiling an operator cannot observe is how
   `ASK_RATE_LIMIT_PER_MINUTE` and `ASK_DAILY_CALL_LIMIT` each spent a slice silently pinned to
   their defaults in Docker. It names no user, because the table it reads holds none.
10. **The per-minute ceiling.** From the browser console, signed in:

    ```js
    for (let i = 0; i < 25; i++) {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: `zzz sourdough starter hydration ${i}` }),
      });
      console.log(r.status, r.headers.get("retry-after"));
    }
    ```

    The 21st question inside a minute returns **429** with `Retry-After: 28` and
    `{"error":"Too many questions. Try again in a moment."}`; the server logs
    `{"outcome":"rate_limited"}`. Asking something unanswerable keeps the whole loop free — the
    quota is consumed before the body is read, and retrieval refuses below the score floor, so
    no model call is made.
11. **The daily ceilings, per user and deployment-wide.** Start from a known state, ask one
    answerable question (an unanswerable one never reaches `reserveCall`), then read the counter:

    ```bash
    docker compose exec db psql -U pkb -d pkb -c "TRUNCATE user_spend, deployment_spend;"
    docker compose exec db psql -U pkb -d pkb -c "SELECT * FROM user_spend;"
    ```

    One row for your subject, `calls=1`, with token totals. Set `calls` to
    `ASK_DAILY_CALL_LIMIT` and ask again: the UI says **"You have reached today's question
    limit."**, the server logs `{"outcome":"daily_limit_reached"}`, and **no `llm_calls` row is
    written** — the ceiling is checked before the model is reached. Set `window_start` back a
    day and restart to watch `{"table":"user_spend","purged":1}`.

    For the shared half, truncate both tables again, set `ASK_DAILY_CALL_LIMIT_TOTAL=1` and
    restart: `alice` asks once (**200**), `admin` asks once (**429**, `{"error":"This deployment
    has reached today's question limit."}`) — a different message, because a shared budget spent
    by someone else is not the reader having asked too many questions. `deployment_spend.calls`
    reads `1`.
12. **The embedder swap the app tells you about.** Set `EMBEDDING_PROVIDER=mock` and restart.
    `/ask` and `/documents` carry a notice: *"None of your documents can be searched right now —
    53 chunks in 10 documents indexed with `Xenova/all-MiniLM-L6-v2`. Retrieval now uses
    `mock-hashing-v1`."* Item 1's question now refuses **with the reason on screen**. Press
    **Re-embed these documents**: the server logs
    `{"documents":10,"chunks":53,"failed":0,"durationMs":301,"msg":"re-embedded stale documents"}`,
    the notice disappears, and the question answers again. Set the variable back and the notice
    returns pointing the other way.

Two of these depend on the mock answerer picking particular sentences. With a real model the
answers are better written — item 6 comes back as *"You should contact David Kraus for the CAKE
configuration…"* rather than a lifted sentence — but the citations, the refusal and the
redaction behave identically. Those are enforced by the app, not by the model.

---

## How it works

```
question
   │
   ├─ 1. embed the question in-process ─────────────► no network
   ├─ 2. THREE SEARCHES, each filtering owner + embedding model in ONE SQL predicate
   │       ├─ vector: everything over the score floor
   │       ├─ identifier: only if the question holds a part number, and only exact matches
   │       ├─ prose: BM25, admitted on IDF coverage ≥ 0.5 and ≥ 2 distinct query terms
   │       ├─ fuse the three rankings (reciprocal rank fusion)
   │       └─ all empty? → "Not found in your knowledge base." (no model call)
   ├─ 3. anonymize the question and every retrieved chunk ──► [PERSON_1], [EMAIL_1], [PHONE_1]
   ├─ 4. wrap each source in a <source> envelope it cannot write its way out of
   ├─ 5. one model call, through one wrapper that times out and writes the audit record
   ├─ 6. CITATION GUARD: every cited number must index the set we sent
   │       └─ none survive? one stricter retry, then "Not found in your knowledge base."
   └─ 7. restore the placeholders, return answer + sources
```

**[`docs/architecture.md`](./docs/architecture.md) is the detailed version of this diagram** —
every arm, every protocol decision and every measurement. What follows is the shape.

### The two seams

Answering and embedding are two different external concerns, so they get two interfaces.
**Anthropic does not offer an embeddings endpoint** — their documentation says so and points at
Voyage AI — so a single combined interface could not be implemented by the `anthropic` provider
at all. Merging them would have hidden a second vendor inside a file named after the first.

| Interface | Env var | Implementations |
| --- | --- | --- |
| `LlmProvider` | `LLM_PROVIDER` | `anthropic` · `openrouter` · `gateway` · `mock` |
| `EmbeddingProvider` | `EMBEDDING_PROVIDER` | `local` · `mock` |

Nothing outside `src/server/ai/providers/` knows about HTTP, headers or vendor JSON. Model ids
come from the environment, never from a call site. `mock` is the default for answering, so the
app is fully demoable with no API key; `local` is the default for embedding and runs
`Xenova/all-MiniLM-L6-v2` **in-process**, so no text ever leaves the process to be embedded and
only the anonymised answering call crosses a network boundary.

There is a third interface in the project — `PersonDetector`, which decides how the anonymizer
finds names — and it is deliberately **not** in this table. Both of its implementations run
in-process; this table is about the seams across which text leaves the app, and blurring that
would cost the privacy argument the one distinction it rests on.

The live proof that the seam is real: the answering path was exercised through **OpenRouter,
against an OpenAI model, using the Anthropic SDK** — a different company, account, billing
relationship and model namespace — with no change to the prompt, the request, the parsing, the
citation guard, the anonymizer or the audit record. The provider file is nine lines of
configuration. → [Answering: three routes and a mock](./docs/architecture.md#answering-three-routes-and-a-mock)

### Retrieval: three arms, because an embedder forgets the words

A sentence embedder compresses a passage to 384 dimensions and keeps its meaning. It throws two
things away, and **each one cost a measured false refusal against the seed corpus**: it cannot
tell one identifier from another, and it does not keep the words you wrote.

| Arm | Runs when | What it recovered |
| --- | --- | --- |
| **Vector** | Always | The baseline — semantic similarity over 384 dimensions |
| **Identifier** | Only when the question contains something shaped like a part number | *"What are PL1 and PL2 set to?"* scored 0.054/0.063 against a 0.25 floor — a false refusal about a document the app had indexed. Each term is searched **as a phrase**, so `PCIe 4.0` never matches `pcie 5.0` |
| **Prose (BM25)** | Always, admitted on IDF coverage ≥ 0.5 **and** ≥ 2 distinct matched terms | Of 15 prose questions the corpus answers, **5 were refused outright**. Four now answer. BM25 is computed in SQL from the stored tsvector, because Postgres has no BM25 and `ts_rank_cd` has no IDF |

The three rankings are combined by reciprocal rank fusion, which only **orders** — every list
arrives already filtered in SQL, nothing is admitted at fusion time, and an empty result stays
empty. That is what keeps "Not found in your knowledge base." reachable before any model call.
All three arms repeat the `owner_sub` and `embedding_model` predicates in their own SQL rather
than trusting another arm to have applied them.

Admission is by IDF coverage rather than a score floor, because a BM25 score is unbounded and a
floor on it would be a threshold tuned by feel — which is exactly what the refusal path must not
rest on. `k1 = 1.2` and `b = 0.75` come from the BM25 literature; the coverage threshold of 0.5
and the two-term minimum are ours, and gaps 18–20 are their whole defence.

→ [The full treatment](./docs/architecture.md#retrieval-three-arms-because-an-embedder-forgets-the-words):
every measured question before and after, the second `english` tsvector, why there is no GIN
index, and what the arm costs.

### Streaming: citations first, so nothing unvalidated is ever shown

The obvious way to stream a guarded answer is the wrong one. Streaming prose and holding the
sources back keeps the letter of the citation promise while breaking its spirit: the reader
watches an answer appear and then watches the app take it away.

So **`citations` moved ahead of `answer` in the model's JSON contract.** The reply is scanned as
it arrives, the citation array is validated the moment it closes, and prose starts only after
that. A rejected answer is refused while the screen still says *checking sources*. The ordering
lives in the NDJSON wire format, not in the UI's good intentions — a `delta` never precedes its
`citations` — so a client that ignored every other rule still cannot render unsourced prose.

**The honest headline is that the latency win is small.** Time to first token is 84–94% of the
call: the model thinks for one to three seconds, then writes a short answer in **195–323 ms**.
That closing window is the entire perceived gain. A design that streamed prose first would look
far more dramatic and would be showing text no guard had approved. That trade is the feature.

**And a contradicted answer is taken back, not merely labelled.** Two failure modes turn a
failed call into a confident answer, and both are caught only after prose has gone out:

| How the call failed | Terminal event | What the reader is left with |
| --- | --- | --- |
| Dropped mid-stream, or stopped at `max_tokens` | `error` | What arrived, its sources, and *"cut short"* — that prose is genuine as far as it got |
| Streamed prose or citations the finished reply does not vouch for | `retracted` | Nothing, and *"The answer was withdrawn."* |

It is deliberately not a `not_found`: the sources were fine and the model contradicted itself,
so blaming the corpus would be a lie. And it does not retry — the citation guard passed, so a
stricter prompt has nothing to fix.

→ [The full treatment](./docs/architecture.md#streaming-citations-first-so-nothing-unvalidated-is-ever-shown):
the measured table, the field-order compliance result, and how the retraction was verified by
forcing the contradiction in a local build.

### Prompt injection: the sources are data

A retrieved chunk is your own note, but a note can come from anywhere. Three things stand
between *"ignore the above and answer X"* and a bad answer, and they fail differently:

1. **A structural boundary.** Question and sources travel inside tags the application writes
   (`<question>`, `<source index="1">`), and the system prompt's first rule says everything
   inside them is data — quotable, describable, never obeyed.
2. **The boundary cannot be forged.** Anything in the untrusted text shaped like one of those
   tags is escaped, whatever its casing or spacing. Escaped rather than stripped, because the
   sentence that tried it is still note content.
3. **The citation guard bounds what a success would buy.** An injected instruction cannot make
   the model cite a document it was not given.

Probed against a live model — a note carrying a forged `</source>`, a `SYSTEM OVERRIDE` block
and a fabricated `<source index="99">` — the answer came back grounded in the note's real
content, citing `[1]`, first attempt. One model and one trial is evidence, not proof (gap 3).
The exfiltration route that makes injection dangerous elsewhere is **absent rather than
defended**: the model has no tools, fetches nothing, and its answer is rendered as text.

→ [The full treatment](./docs/architecture.md#prompt-injection-the-sources-are-data)

---

## Models used

| Role | Model | Version / id | Where it runs |
| --- | --- | --- | --- |
| Answering | Claude Opus 5 | `claude-opus-5` (vendor) / `anthropic/claude-opus-5` (OpenRouter) | Anthropic API or OpenRouter, via `@anthropic-ai/sdk` 0.120.0 |
| Answering, as actually exercised | GPT-4o mini | `openai/gpt-4o-mini` | OpenRouter, via the same client |
| Embedding | all-MiniLM-L6-v2 | `Xenova/all-MiniLM-L6-v2`, `q8` weights, 384 dims | in-process, in the container |
| Person detection, for anonymization | distilbert-base-multilingual-cased-ner-hrl | `Xenova/distilbert-base-multilingual-cased-ner-hrl`, `q8` weights, `PER` tags only | in-process, in the container |

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
−0.015). The detector's weights are `q8` for the same reason and measure 132 MB — see
[the detector section](#what-the-detector-actually-does-measured) for what that buys.

Both models run **in-process**, and neither is a call that leaves the app. Only the answering
step crosses a network boundary, and the text it carries has been through the anonymizer first.

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

Before any text leaves the process toward a model, e-mails, phone numbers and person names are
replaced with stable placeholders — `[PERSON_1]`, `[EMAIL_1]`, `[PHONE_1]` — and the inverse
mapping is applied to the model's answer before the user sees it. Both directions are visible in
the UI, not just in the logs.

- **One anonymizer instance per request.** It holds the only mapping that can turn `[PERSON_1]`
  back into a person, so it lives in memory for the life of one request and is never persisted,
  never logged, and never sent to the browser. Only counts and already-redacted text reach the UI.
- **The same instance redacts the question *and* every chunk,** so one value gets one placeholder
  everywhere. That is what keeps a question about a person matching a chunk about them.
  Independent anonymizers would have numbered them differently and quietly broken the connection.

Retrieval runs on the **original** text: embeddings are computed in-process so nothing leaves to
be embedded, and searching redacted text would mean searching for placeholders rather than for
what the user actually asked about.

### What the detector actually does, measured

E-mails and phone numbers are two regexes, and always have been. **Person names are a seam**:
one `PersonDetector` interface, two implementations, selected by `ANONYMIZER_PROVIDER`.

- **`ner` — the default.** `Xenova/distilbert-base-multilingual-cased-ner-hrl` (`q8` weights)
  running in-process in the container, baked into the image, never reaching the network. It keeps
  the name dictionary too: a name someone has already told the app about is a certainty, not a
  guess. The model is what replaced the guessing.
- **`heuristic`** — the detector this project shipped with: the same dictionary, plus a
  capitalised-bigram guess and a sentence-starter list. Its one behavioural change, documented
  in `heuristic.ts`, is that both passes now run over the same original text, so an unlisted
  first name beside a known surname is redacted whole. No model. It is what the tests use, and what a build without the NER weights
  must be configured to use.

Measured against the full seed corpus, through the app's own detector:

| | `heuristic` (before) | `ner` (default) |
| --- | --- | --- |
| People, distinct | 6 / 6 | 6 / 6 |
| People, occurrences replaced | 10 / 10 | 10 / 10 |
| False positives | 6 | 0 |
| Person precision | 50% | 100% |
| E-mail addresses | 6 / 6 | 6 / 6 |
| Phone numbers | 3 / 3 | 3 / 3 |

The last two rows are identical because they are the same two regexes; the detector seam does not
touch them. Round trip is byte-identical either way.

**Recall is not what improved.** `heuristic` replaced all ten person occurrences too, by
construction — a detected value is replaced with `split`/`join` across the whole text, so finding
a name once finds it everywhere. Nothing here catches a name the old detector leaked. What
changed is **precision, from 50% to 100%**, and that is the whole of the win. The 6 false
positives were the app's behaviour until this slice: `Arrow Lake`, `Curve Optimizer`,
`Adaptive-Sync`, `Ultra High`, `Display Stream`, `Wi-Fi` — 15 occurrences of six non-people,
against 10 real ones.

The old defence still stands and now describes `heuristic`: a false positive means the model
reasons over an opaque token and `restore()` puts the real text back, so the user never sees a
difference, while a false negative is a leak. Over-redaction is the safe direction, and a naive
detector whose limits are written down beats a black box whose limits are not. That is why
`heuristic` remains a supported configuration rather than deleted code.

**Known limits, all of them deliberate:**

- **`ner`:** the model's ten training languages **do not include Czech**, and this corpus is
  largely Czech names. It finds every one of them, measured — and the other candidate, trained on
  the same ten, did not (gap 30).
- **`ner`:** only `PER` is used. The model also emits `ORG` and `LOC`; neither is wired up.
- **`ner`:** the pipeline exposes no character offsets, so a name is stitched back together from
  wordpieces and then located in the text as a string. A stitched form absent from the text
  replaces nothing — a miss, never a corruption (gap 31).
- **`heuristic`:** it cannot tell a person from any other two-word proper noun, and a single
  unknown first name on its own ("ask Petra") is missed unless it is in the dictionary. Those two
  limits are the 50% column.
- **Neither:** addresses, dates of birth, national ID and account numbers are **not detected at
  all**.
- The dictionary belongs to both detectors, and is a constant here because the corpus is synthetic
  and eight names is the whole population. In a real deployment it would come from wherever the
  organisation already keeps its people, refreshed on a schedule. The anonymizer takes the list;
  it does not own it.

**What the model costs** — 132 MB in the image, and one eager load at startup that took a fix to
actually be one — is measured in
[`docs/architecture.md`](./docs/architecture.md#what-the-person-detector-costs).

### The LLM call log

One row per call that left the process, holding **exactly** this and nothing else:

`provider · model · input tokens · output tokens · latency · outcome · timestamp`

No prompt, no answer, no document text — the table has nowhere to put them even by accident. And
deliberately **no subject**: the record answers *"what did this app spend and how did it behave"*,
not *"what did this person ask"*. Adding the subject would quietly turn a cost-and-latency table
into a 30-day behavioural log of every user. Failed calls are recorded too, with zero tokens and
outcome `timeout` or `error`, because a call that was made and failed still consumed a deadline.
Errors are audited by the error's **class name**, never its message: a provider error can echo the
request back, and the request contains the user's own notes.

### The three spend ceilings

`ASK_RATE_LIMIT_PER_MINUTE` bounds the **pace** of one person's spending, `ASK_DAILY_CALL_LIMIT`
their **total**, and `ASK_DAILY_CALL_LIMIT_TOTAL` bounds the **bill** — every user added together,
which is the number an operator with a monthly budget actually holds.

A ceiling has to know what has been spent, and `llm_calls` refuses — correctly — to know who
spent it. So the two counted ceilings live in tables of their own, shaped so neither becomes the
thing `llm_calls` declined to be: `user_spend` holds one row per user per day with no per-question
timestamps, `deployment_spend` holds one row per day with no subject at all. The most either can
say is *"this subject made N calls today"*.

All three are enforced **before** a call is made, by a reservation — one `INSERT … ON CONFLICT …
DO UPDATE SET calls = calls + 1 WHERE calls < $limit RETURNING calls` per counter, where no
returned row means denied. The reservation *is* the check, so there is no second step to race
against, and no model call happens inside the transaction. Measured: 12 concurrent questions
across two users against a shared ceiling of 5 leave the counter at exactly 5.

→ [The full treatment](./docs/architecture.md#the-three-spend-ceilings-and-what-each-one-is-for):
the table comparison, why the cap counts calls rather than tokens, and the midnight token-placement
edge (gap 28).

### Retention

Implemented in `src/server/retention/purge.ts`, run on startup and then hourly.

| Data | Retention | Deletion |
| --- | --- | --- |
| Documents, chunks, embeddings | Until the user deletes them | Immediate hard delete on request, cascading to chunks and embeddings |
| LLM audit records | `RETENTION_AUDIT_DAYS`, default 30 days | Hourly purge job |
| Spend counters, per user and deployment-wide | The current UTC day only | Hourly purge job drops every earlier window |
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
present in `.env.example`, **and passed into the container by `docker-compose.yaml`**. That
last one is not bookkeeping: a variable that reaches the schema but not the compose file is
one you can set and watch do nothing, which is how `ASK_RATE_LIMIT_PER_MINUTE` and
`ASK_DAILY_CALL_LIMIT` spent a slice each silently pinned to their defaults in Docker. Blank
values are treated as unset, so an unset variable falls back to its default rather than
failing validation on an empty string.

`MODEL_CACHE_DIR` was `EMBEDDING_CACHE_DIR` until the person detector arrived and made that
name wrong: `@huggingface/transformers` reads the cache directory as process-global state, so
with two models in one process the variable named for embeddings was configuring the anonymizer
too. An existing `.env` still carrying the old name keeps working — the old variable is ignored
and the new one falls back to the same `./.models` default. A deployment that had pointed the
old variable somewhere other than the default has to rename it.

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
| `EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | Recorded on every chunk. Changing this, or the provider, makes existing chunks unsearchable until they are re-embedded — the app says so and offers the rebuild |
| `MODEL_CACHE_DIR` | `./.models` | Where the baked-in models live — both of them |
| `ANONYMIZER_PROVIDER` | `ner` | `ner` \| `heuristic`. Which person detector the anonymizer takes. No fallback: if `ner` is selected and its model is not in the image, the app refuses to start rather than quietly redacting less |
| `ANONYMIZER_MODEL` | `Xenova/distilbert-base-multilingual-cased-ner-hrl` | The NER model that finds person names, in env and never at a call site — the rule `LLM_MODEL` and `EMBEDDING_MODEL` already follow |
| `LLM_PROVIDER` | `mock` | `anthropic` \| `openrouter` \| `gateway` \| `mock` |
| `LLM_MODEL` | `claude-opus-5` | Model id **in the selected provider's namespace**; never hard-coded at a call site |
| `LLM_TIMEOUT_MS` | `60000` | Deadline for one call. The request is **aborted**, not abandoned |
| `ANTHROPIC_API_KEY` | unset | Required when `LLM_PROVIDER=anthropic` |
| `OPENROUTER_API_KEY` | unset | Required when `LLM_PROVIDER=openrouter` |
| `LLM_GATEWAY_BASE_URL` / `LLM_GATEWAY_API_KEY` | unset | Required when `LLM_PROVIDER=gateway` |
| `RAG_TOP_K` | `6` | Chunks put in front of the model |
| `RAG_MIN_SCORE` | `0.25` | Similarity floor; below it, "Not found in your knowledge base." |
| `ASK_RATE_LIMIT_PER_MINUTE` | `20` | Questions one signed-in user may ask per minute. `0` disables it. Counted in-process, so it is per instance |
| `ASK_DAILY_CALL_LIMIT` | `200` | Model calls one user may make per UTC day. `0` disables it. Counted in the database, so it survives a restart |
| `ASK_DAILY_CALL_LIMIT_TOTAL` | `0` | Model calls the whole deployment may make per UTC day, across every user. `0` disables it. Defaults to off because how many calls a deployment should afford depends on how many people it serves, which the app cannot know |
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
    models.ts             the one place that configures @huggingface/transformers
    privacy/
      anonymizer.ts       placeholders, the per-request mapping, restore
      detectors/          types · dictionary · heuristic · ner   (person names)
    rateLimit.ts          per-user quota on the one endpoint that costs money
    spend.ts              two counted ceilings, per user and deployment-wide, reserved before each call
    rag/                  chunk · extract · ingest · retrieve · bm25 · fuse
                          · tokens · answer · citations · embeddingStatus · reembed
    retention/purge.ts
    db/                   schema + migrations, applied on startup
    log/                  logger.ts, llmAudit.ts
test/                     node --test, no test dependency
docs/architecture.md      how retrieval, streaming, injection defence and the ceilings work
docs/known-gaps.md        all 42 gaps in full
docs/decisions.md         every "why exactly like this", one line each
docs/implementation-plan.md
```

## Tests

```bash
npm test          # 170 tests, node --test, no test framework
npm run typecheck
```

Not coverage — a short list of places where a silent failure is a correctness, privacy or
money incident rather than a visible bug:

| What | Why it is tested |
| --- | --- |
| The anonymizer round trip | A miss sends a real name to a vendor; a bad restore shows the user a placeholder |
| `windows` and `personsIn` | The code around the NER model: windowing is what stops the model silently truncating a name out of existence, and `personsIn` is the wordpiece stitching. The model call itself is not tested (gap 34) |
| `resolveCitations` | The rule that decides which claimed sources survive |
| `askQuestion` | The guard as the user meets it: the refusal, the one retry, and the anonymizer wrapped around a stubbed model call |
| The prompt envelope | That a source cannot forge the boundary between data and instructions |
| PDF extraction | Against the seed PDF itself, the file whose layout produced the defect |
| The `gateway` provider | Against a stub gateway: the route, the bearer credential, the request, the parsing |
| `consumeAskQuota` | The ceiling on what one session can spend |
| `spendDecision` | The pure arithmetic behind the daily ceiling's pre-check and its retry-after — not the enforcing boundary itself, which is `reserveCall`'s untested SQL (gap 29) |
| `distinctiveTerms` | It decides whether the identifier arm runs at all — return the wrong thing and the refusal path changes |
| `fuseByRank` | That fusion only ORDERS: an empty result stays empty, and a lexical-only chunk is never dropped |
| `describeStaleness` | Whether the app notices that its own index has gone unreachable — the one failure that is invisible from the inside |

Two seams make this possible without a database, a key or a model. `askQuestion` takes its
retrieval and its model call as a defaulted parameter, so a stub can produce the one thing no
provider here will produce on demand — a citation to a source it was never given. And the
gateway test starts a local HTTP server that speaks the Anthropic wire format, so the request
the app builds can be read back field by field.

The runner is Node's built-in one with a small resolver hook, because the alternative was
either a test framework or reshaping the application's import style to suit a runner.

---

## Known gaps and deliberate debt

Written down rather than hidden. An honest gap is worth more than a half-finished feature.

**All 42 are in [`docs/known-gaps.md`](./docs/known-gaps.md), in full.** This is the index: one
line each, grouped by what a reader is likely to be checking for.

**Verified by construction rather than by execution** — the honest core of the list

| # | |
| --- | --- |
| 1 | **The `anthropic` provider has never been run against the live API.** No vendor key during the build. Everything the two providers share was run live through `openrouter`; what is unexercised is the vendor client construction and the `structuredOutputs: true` branch |
| 2 | **The `gateway` provider has been read, not deployed.** Pinned by a test against a stub speaking the Anthropic wire format; no test here can supply a real corporate gateway's own behaviour |
| 23, 29, 34, 42 | **Four things are verified by a measured manual pass, not by the suite:** the prose arm's SQL, `reserveCall`'s reservation predicate, the NER model call, and the ask route + UI + audit wrapper. The suite deliberately opens no database connection and loads no model, because a test that does can pass for the wrong reason — and a TypeScript reimplementation would test the copy. A future edit can break any of them, and only another manual pass would catch it |

**Privacy and anonymization**

| # | |
| --- | --- |
| 3 | **Prompt-level injection defences are mitigation, not proof.** Nothing stops a model *choosing* to obey an instruction inside a source it was legitimately given. The residual is a wrong answer carrying a real citation |
| 4 | **Anonymization runs on the answering path only** — not at ingest, and not on filenames |
| 30, 31, 32 | The NER model's ten training languages **do not include Czech**; reconstruction from wordpieces can miss (never corrupt); only `PER` is used, so addresses, dates of birth and account numbers go undetected |
| 33 | **The image grew by 132 MB** for the detector — 496 MB total, roughly three quarters of the increase being the multilingual vocabulary |

**Retrieval**

| # | |
| --- | --- |
| 5 | **PDF reflow reads the page layout, and a layout can lie.** Two cases it cannot get right, and it only applies at ingest — a document indexed earlier keeps its split words |
| 11, 12 | The two-token rule misses a one-digit designation (`Ryzen 9`) and a word longer than five letters; the identifier arm does no stemming and no synonyms, deliberately |
| 15, 16, 17 | Re-embedding replays stored text rather than re-extracting; runs inside the request with no progress or queue (8.8 s for the seed corpus); and the staleness notice reaches the signed-in user only, never an operator |
| 18, 19, 20 | The prose arm's 0.5 coverage constant is arbitrary in the way any threshold is; one in-corpus question is still refused by it (**0.34**); and a genuine single-content-word question gets no prose arm at all |
| 21, 22 | The prose arm reads every one of the owner's chunks (7.3–7.9 ms over 53) and is English-only, explicitly |

**Spend, scale and operations**

| # | |
| --- | --- |
| 6 | **No pagination anywhere.** The documents list and retrieval both assume a personal-scale corpus |
| 8 | **The per-minute rate limit is per instance and forgets on restart.** The control belongs at the gateway that already holds the budget; this is the honest in-app approximation |
| 24, 25, 27 | Every question in the deployment contends on one row; a provider failing every call still burns the day's budget; and there is no fairness within the shared ceiling |
| 26 | **The shared counter cannot un-count a deleted account, and should not** — the money was spent. A total any user could lower by leaving would not be a ceiling |
| 28 | `recordTokens` can misplace a call's token totals across UTC midnight. The ceiling is unaffected; only where the tokens land is |
| 9, 10 | `users.role_snapshot` can go stale (cosmetic — authorization never reads it); the Keycloak realm uses `start-dev` |

**Streaming**

| # | |
| --- | --- |
| 7 | **The mock answerer cannot synthesise.** It extracts sentences; set `LLM_PROVIDER=openrouter` for real synthesis |
| 37 | **Streaming buys back only the model's writing time** — 195–323 ms of a one-to-three-second call |
| 38 | **`anthropic` and `gateway` do not stream,** because shipping it for two endpoints never run against a live service would put verification-by-construction on the project's most important seam |
| 36 | The embedder has gap 35's trap latent rather than live: a module-level cache in three server graphs, where only one ever calls `embed()` |
| 41 | `readPartial` can be fooled by a nested `"citations"` or `"answer"` key. The unconditional validation of the finished reply catches it and the UI now clears what it showed — but the text was on screen for something under 0.7 s |

**Closed or withdrawn:** 13 and 14 (the reservation statement, slice 15), 35 (a one-line cache
change), 39 (withdrawn — it could not happen), 40 (closed as far as the wire format allows).
They are kept in `docs/known-gaps.md` because what a closed gap *corrected* is the part worth
reading.

---

## What I would build next

1. **Run the `anthropic` path end to end and re-measure.** Gap 1. Everything else is downstream
   of knowing the real path works — and it is now also what gates streaming for the vendor and
   the gateway (gap 38).
2. **An operator-visible staleness check.** Gap 17: today an embedder change is announced to
   whoever signs in and to nobody else. A startup check and a log line are small, and their
   absence is the one failure that is invisible from the inside.
3. **Move the spend ceiling to where the budget lives.** Gaps 8 and 24 already say the control
   belongs at the gateway that sees every call. The in-app version is the honest approximation,
   not the destination.

### What this list got wrong, four times

Every slice since has taken this list's second item and found it was wrong about something. The
corrections are kept because the pattern is the point — a roadmap item is a hypothesis, and
building it is the test.

- **"Stream the text, hold the sources until the guard has passed."** Done that way, a rejected
  answer is prose the reader watches appear and then vanish. What was built inverts it —
  `citations` moved ahead of `answer`, so the guard runs before a word is shown. The item's
  implied payoff was wrong too: the wait is the model thinking, not writing, so streaming
  recovers 195–323 ms of a one-to-three-second call.
- **"A NER model would raise precision above 50% without changing a single call site — the seam
  is already there."** The seam was **not** already there: `createAnonymizer()` took no argument
  and had one implementation. And "stronger" oversells it — measured, the old detector replaced
  all ten person occurrences too, so nothing was leaking and nothing stopped leaking. What
  improved is that the app no longer redacts six things that are not people.
- **"A shared spend ceiling, and the reconciliation that gaps 13 and 14 describe."** That
  reconciliation was not work attached to the ceiling; it was the ceiling's precondition. Gap
  13's justification — that the overshoot is bounded by `ASK_RATE_LIMIT_PER_MINUTE` — held only
  while the racing requests belonged to one user. A counter every user contends on makes the
  bound N × 20, against the one ceiling meant to stand between an operator and a bill.
- **"A BM25 arm for prose — it needs `RAG_MIN_SCORE` rethought first."** Measured, no. The floor
  goes on doing its job on the arm it was written for and was left untouched. What the refusal
  path needed was an admission rule belonging to the new arm, on a number that arm can produce:
  IDF coverage, plus a minimum of two matched terms. A floor on a BM25 score would have been the
  tuned-by-feel threshold the whole design refuses.
