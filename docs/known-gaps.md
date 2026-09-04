# Known gaps and deliberate debt

Written down rather than hidden. An honest gap is worth more than a half-finished feature.

The [README](../README.md#known-gaps-and-deliberate-debt) summarises this list in one line
each. This file is the full text: what the limit actually is, what it costs, and — where the
gap has since been closed or withdrawn — what closing it corrected.

**Five entries are struck through:** 13 and 14 were closed by the reservation statement in
slice 15, 35 by a one-line cache change, 39 was withdrawn as wrong, and 40 was closed as far
as the wire format allows. They are kept, condensed, because what a closed gap corrected is
the part worth reading.

---

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
2. **The `gateway` provider has been read, not deployed.** Its request is now pinned down by
   a test against a stub that speaks the Anthropic wire format: the route, the
   `Authorization: Bearer` credential, the model id, the absence of a vendor `x-api-key`, the
   prompt, and the parsing of a reply that arrives as prose around JSON. What no test here can
   supply is a real corporate gateway's own behaviour — its auth scheme, its error shapes, its
   idea of which API features it fronts. The file is written for the common case where the
   gateway is Anthropic-API-compatible (LiteLLM, Azure API Management and similar all are); a
   proxy with its own wire format would be a different file implementing the same interface,
   which is the point, but it remains a point made in a test rather than in production.
3. **Prompt-level injection defences are mitigation, not proof.** The envelope stops a source
   forging the boundary, and the citation guard stops a successful injection from citing
   anything outside your own corpus — but nothing here stops a model from *choosing* to follow
   an instruction written inside a source it was legitimately given. The probe described above
   was refused by `gpt-4o-mini` on the first attempt, which is one model on one prompt on one
   day; a different model, or a subtler instruction, is an open question and there is no
   regression test that could close it. The residual outcome is a
   wrong answer carrying a real citation, and no detector in the app would catch it. That is
   why the seed corpus is synthetic and the defence is structural: the honest claim is a
   narrowed attack surface, not immunity.
4. **Anonymization runs on the answering path only.** It is not applied at ingest, and it is
   not applied to filenames. Uploading a document named `notes-about-marek-dvorak.md` puts
   that name in the UI and in the source link. Deliberate — ingest-time redaction would make
   every stored document permanently lossy — but it is a real gap.
5. **PDF reflow reads the page layout, and a layout can lie.** Words split across a line by
   the page layout (`"compar\ning"`) are rejoined by comparing each line's right edge with the
   page's margin, which is what the layout itself used to decide the break. Two cases it
   cannot get right: a document whose own line happens to end exactly at the margin loses that
   line break, and a hyphen at a break is kept rather than resolved, because no dictionary
   here can tell `"self-\nhosted"` from a word that simply ends in one. And it only applies
   at ingest — a document indexed before this change keeps its split words, invisible to
   retrieval, until it is uploaded again. Re-embedding does not rescue it either: that
   replays the stored text rather than re-reading the file (gap 15). (Checked in the running app by ingesting the seed
   PDF twice: the older copy still reads `they a\nre`, `compar\ning`, `NV\nMe` and
   `configur\nation`; the newer one, none of them.)
6. **No pagination anywhere.** The documents list and retrieval both assume a personal-scale
   corpus. At a few thousand documents the list page would need it.
7. **The mock answerer cannot synthesise.** It extracts sentences. A question whose answer is
   spread across three notes gets the single closest passage, not a summary. Set
   `LLM_PROVIDER=openrouter` (or `anthropic`) for real synthesis.
8. **The rate limit is per instance and forgets on restart.** `ASK_RATE_LIMIT_PER_MINUTE`
   bounds what one signed-in user can spend in a loop, counted in the app's own memory. Two
   replicas therefore mean twice the limit, and a restart forgives everyone — the safe
   direction to be wrong in for a spend ceiling, but a real limitation. The control belongs at
   the gateway that already sees every call and holds the budget; this is the honest in-app
   approximation of it, not a replacement. `ASK_DAILY_CALL_LIMIT` is counted in the database
   instead, so it survives both a restart and a second replica — gaps 13 and 14, the race in
   that counting, are closed as of slice 15, and gap 24 below is what the same table costs once
   a shared counter is contended by every user rather than one.
9. **`users.role_snapshot` can go stale.** It is refreshed at sign-in and used only for
   display and the admin count. Authorization never reads it, so a stale value is cosmetic —
   but anyone reading the schema should know it is there and why it is not authoritative.
10. **The Keycloak realm uses `start-dev`.** Correct for a mock IdP, wrong for anything else.
11. **The two-token rule misses a one-digit designation, and a word longer than five
    letters.** `LGA 1718` and `PCIe 5.0` are found; `Ryzen 9` is not, because one digit after
    a word is more often a count than a designation, and `memory 6000` is not, because five
    letters is where identifiers stop and sentences start. Both limits are the price of not
    pairing `since 2023` and `under 1500` with everything they precede, and both are
    arbitrary in the way any threshold is. The function-word list that does the rest of that
    work is deliberately tiny and English-only.
    (This gap previously claimed the seed corpus contained no two-token identifier to test
    against. That was wrong — `LGA 1700/1718/1851` is in two documents and `PCIe 3.0/4.0/5.0`
    in three — and the rule was built and measured against them.)
12. **The *identifier* arm does no stemming and no synonyms.** It uses the `simple`
    dictionary, so it matches identifiers exactly and matches nothing else — `NVMe` will not
    find `NVM`, and a typo finds nothing. That is the intended trade for a part-number arm, and
    it is why stemming lives in a second column rather than in this one: stemming a part number
    can only lose information, while for prose it is the whole value (`underweight` matches 0
    chunks under `simple` and 2 under `english`). This gap used to say "the lexical arm", full
    stop, and to claim that ordinary prose questions remained entirely the vector arm's job.
    Since the prose arm exists that is no longer true, and the narrowing is the point.
13. **~~The daily cap is checked and incremented separately~~ — closed in slice 15.** A call is
    now reserved before it is made, by one
    `INSERT … ON CONFLICT … DO UPDATE SET calls = calls + 1 WHERE calls < $limit RETURNING calls`
    per counter: no returned row means denied, so the reservation *is* the check and there is no
    second step to race against. Measured, 12 concurrent questions against a shared ceiling of 5
    leave the counter at exactly 5; the old read-then-write could overshoot by however many
    requests were in flight.
    **What closing it corrected:** slice 11 had rejected exactly this shape, on the grounds that
    counting before the call "charges for calls that then fail" — while gap 14 complained about
    the same behaviour from the other side. Both were written the same day and only one could be
    right. Gap 14 was, so one statement closed both, and charging for a failed call is the
    behaviour rather than its price. Still rejected, for slice 11's reason unchanged: a lock held
    across the model call.
14. **~~A model call that times out or errors is not counted against the daily cap~~ — closed as
    a consequence of 13.** Measured against a black-holed gateway (`LLM_PROVIDER=gateway`,
    `LLM_GATEWAY_BASE_URL=http://10.255.255.1:8080`, `LLM_TIMEOUT_MS=2000`) rather than the
    default `mock`, which runs in-process and gives `AbortSignal.timeout` nothing to abort — so
    even `LLM_TIMEOUT_MS=1` against it still returns `outcome=ok`: `llm_calls` records
    `outcome=timeout, latency_ms=2001` with zero tokens, as before, and both `user_spend.calls`
    and `deployment_spend.calls` now read 1 where they used to read 0.
15. **Re-embedding replays stored text; it does not re-extract.** The input is
    `documents.content`, the text as the extractor read it at upload — so a document ingested
    before a change to extraction keeps whatever that extractor produced, and the PDF
    line-break repair of gap 5 still reaches only documents uploaded after it. The name
    invites the wrong expectation, which is why both gaps say so.
16. **Re-embedding runs inside the request, with no progress and no queue.** 8.8 s for the
    seed corpus; a corpus ten times the size is a request nobody wants to hold open. It is
    idempotent per document — a rebuilt document is no longer stale, so it is not selected
    again — so the recovery from a timeout is to press it again, which is the honest
    minimum and not a substitute for a job runner. Same personal-scale assumption as gap 6.
17. **The mismatch is announced in the UI only, per user.** An operator who changes the
    variable and never signs in sees nothing: there is no startup check, no log line and no
    way to re-embed on behalf of everyone. For a single-user knowledge base that is the whole
    population, and for anything larger it is the first thing to add.
18. **The prose arm's 0.5 coverage constant is arbitrary in the way any threshold is.** It is
    derived from a measured separation on one corpus of 53 chunks, over full-sentence questions
    only — answerable ones at 0.63 and above, unanswerable ones at 0.23 and below — and not from
    theory. Coverage alone fails on short questions, which is why the two-term minimum below
    (gap 20) exists. `k1 = 1.2` and
    `b = 0.75` are adopted from the BM25 literature and are defensible on that basis; 0.5 and
    the two-term minimum are ours, and this line is the whole of their defence. The constants
    are deliberately not environment variables: the refusal path should not be tunable until a
    demo passes, so the honest version of that choice is to write the number down here.
19. **A vague question is now refused for a new reason.** *"What contradiction did I never get
    to the bottom of?"* has a best coverage of **0.34** and does not clear the bar, from a
    corpus that contains a section headed *"unresolved contradiction"*. The vector arm refused
    it before this slice and refuses it still; the prose arm was the thing that could have
    rescued it, and its admission rule turns it away too. It is the one of the five measured
    false refusals this slice set out to close that stayed shut, and it was predicted to stay
    shut before the arm was built rather than discovered afterwards.
20. **A genuine single-content-word question gets no prose arm at all.** Admission requires two
    distinct matched query lexemes, so a question that reduces to one content word — after
    `english` strips the stopwords — is never admitted, however real it is. That rule exists
    because coverage is a *share* and saturates: measured, `notes` alone matched at coverage
    1.000 with 31 of 53 chunks qualifying and `power` with 18 of 53, which would have put
    vacuous questions in front of the model and moved the citation guarantee's first line of
    defence off retrieval and onto the model obeying its prompt. "One word is not a question"
    is the defensible form of the rule, and this is what it costs: such a question falls back
    to the vector arm alone.
21. **The prose arm reads every one of the owner's chunks.** BM25 needs corpus-wide statistics
    — `N`, `avgdl` and `df` — so there is nothing to narrow the scan to, and no index that
    could help: the query never issues a `@@` match, which is why `content_tsv_en` has no GIN
    index and why the design's promise of one was dropped. Measured at 7.3–7.9 ms over 53
    chunks. Fine at personal scale, and the same assumption as gap 6.
22. **The prose arm is English-only,** explicitly so, because it names the `english` text search
    configuration in both the generated column and the query. A corpus in another language
    would be stemmed by the wrong rules and its stopwords would not be stripped. The identifier
    arm's `simple` dictionary stays language-neutral; the vector arm's reach is whatever
    `all-MiniLM-L6-v2` was trained on.
23. **The prose arm's SQL has no automated test, and this is a deliberate deviation from what
    the design promised.** The design said the coverage arithmetic would get a unit test. Every
    branch of it turned out to be SQL — coverage, the term count, the admission predicate, the
    ordering — and the test suite deliberately opens no database connection, because a test
    that does can pass for the wrong reason. A TypeScript reimplementation of the arithmetic
    would test the copy rather than the query, which is the failure mode slice 13's `&&`
    precedence bug already demonstrated: a green suite past a broken query. The controlling
    verification is instead a measured pass against the running stack, recorded in the
    retrieval section above. The residual risk is plain: a future edit to that SQL can break
    retrieval, and only another manual pass would catch it. Same spirit as gaps 1 and 2, which
    admit that the `anthropic` and `gateway` providers are verified by construction rather than
    by execution.
24. **Every question in the deployment contends on one row.** The shared
    counter is a single row and every reservation locks it. Inside a
    transaction holding two indexed upserts and no network call that is
    microseconds, at the personal scale gap 6 already assumes. At real scale it
    is a serialisation point on the hottest path, and the answer there is a
    sharded counter or a budget held by the gateway — which is where gap 8
    already says this control belongs.
25. **A provider failing every call still burns the day's budget.** That is the
    deliberate direction — gap 14 above asked for exactly it — and it has a
    cost: an outage can exhaust the ceiling without a single answer being
    produced. The alternative is a refund path, which is a compensating write
    that can itself fail, and a ceiling that goes generous during an outage is
    the worse of the two.
26. **The shared counter cannot un-count a user who has deleted their account,
    and should not.** "Delete my account" wipes their `user_spend` row; their
    contribution to the deployment's total stays, because the money was spent.
    It is the visible asymmetry between the two tables, and it is written down
    because the instinct on reading §7's promise is that this is a bug. A total
    any user could lower by leaving would not be a ceiling.
27. **No fairness within the shared ceiling.** One user can consume all of it,
    bounded only by their own per-user cap. Fair shares mean per-user quotas
    expressed against the total, which is a larger feature than this one.
28. **`recordTokens` can misplace a call's token totals across UTC
    midnight.** The call is charged at reservation time against that
    moment's window; the token totals are added after the provider answers,
    against a window recomputed at THAT moment. A call reserved at 23:59:58
    and answered four seconds later updates the next day's rows — matching
    nothing and silently dropping the tokens if those rows don't exist yet,
    or landing on them and adding to the next window's totals if another
    reservation already created them. The ceiling is unaffected either way —
    it counts calls, and the call was already charged — so only where the
    token totals end up is in question. Closing it means threading the
    reserved window through to `recordTokens`, which is a change to a
    reviewed type plus a field in every test stub, to recover reporting for
    the handful of calls in flight across one midnight a day. Written down
    instead.
29. **`reserveCall`'s reservation SQL has no automated test.** The predicate
    that actually enforces both ceilings — the `WHERE calls < $limit` inside
    each upsert — is SQL, and the test suite deliberately opens no database
    connection, because a test that does can pass for the wrong reason. A
    TypeScript reimplementation of the predicate would test the copy rather
    than the query, which is the failure mode slice 13's `&&` precedence bug
    already demonstrated — a green suite past a broken query — the same
    reasoning gap 23 recorded for the prose arm's SQL one slice earlier.
    `spendDecision`, tested above, is not this predicate: it is the pure
    arithmetic behind `checkDailySpend`'s pre-check and the retry-after, and
    `checkDailySpend` says so itself — "This is NOT the control." The
    controlling verification is instead the measured concurrent burst
    against the running stack, recorded in the spend section above: 12
    concurrent requests against a ceiling of 5 leave the counter at exactly
    5. The residual risk is plain: a future edit to that SQL can break the
    ceiling, and only another manual pass would catch it.
30. **The detector model's ten training languages do not include Czech,** and this corpus is
    largely Czech names. It finds every one of them, measured — and the other candidate,
    trained on the same ten languages, did not: it missed `Radek Pokorný` and stitched the
    pieces of it into `Poný`, a string that appears nowhere in the corpus. Nothing on either
    model card would have said which of the two would cope. Working here is evidence, not a
    guarantee, and a corpus in a language further from those ten needs its own measurement
    before anyone relies on this.
31. **Reconstruction can miss, and the honest bound is "never corrupts".** The pipeline exposes
    no character offsets, so a detected name is stitched back out of wordpieces and then found
    in the text as a string. A stitched surface form that is absent from its window is dropped,
    silently — no error, no log line, nothing in the UI. That is by design preferable to
    splicing at a guessed offset, which would corrupt the text the model reads, but the
    guarantee is only that a failure loses a redaction rather than mangling a document. On this
    corpus all ten reconstructions were present verbatim.
32. **`PER` only.** The model also emits `ORG` and `LOC`; neither is used, because neither is
    what the requirement asks for. Addresses, dates of birth, national ID and account numbers
    remain undetected, exactly as the detector section's known limits already say.
33. **The image grew by 132 MB** — `.models` went from 23 MB to 155 MB, and the whole image is
    496 MB. By parameter count, roughly three quarters of the increase is the multilingual
    vocabulary that makes the Czech names work; the rest is the wider encoder. A single-language
    model such as `distilbert-base-cased` (same 768/6/3072 shape, ~65M parameters) would be
    roughly half the size and would not do this job.
34. **No automated test covers the model call itself.** `windows` and `personsIn` — the
    windowing that prevents silent truncation, and the wordpiece stitching — are pure functions
    in this project's own source and are tested. The pipeline they feed is not: the suite loads
    no model for the same reason it opens no database connection, because a test that does can
    pass for the wrong reason, and a TypeScript reimplementation of the model's behaviour would
    test the copy. Same admission as gaps 23 and 29, and the controlling verification is the
    same shape: a measured pass against the running stack, recorded in the detector section
    above. The residual risk is plain — a future change to the model, the dtype or the
    stitching can degrade detection, and only another manual pass would catch it.
35. **~~The eager warm-up does not warm the instance the request path uses, so the model loads
    twice, not once~~ — closed, by the small change the gap itself named.** `ner.ts` caches the
    loaded tagger on `globalThis` rather than in a module-level `let`, because a module-level
    cache is per Next.js server entry and `globalThis` is per process. Measured against the
    running stack: **2 loads before** (898 ms at startup, then 664 ms on the first question),
    **1 after** (865 ms at startup, and the first question loads nothing). The build output
    confirmed the mechanism rather than leaving it inferred — the loader sits in exactly two
    server graphs, one reached from `instrumentation` and one from `app/api/ask/route` — and a
    count of 1 after the fix rules out the alternative explanation, that
    the container ran more than one Node worker.
    **What closing it corrected:** the gap predicted two resident copies of a 132 MB model, which
    follows from the code but was not confirmable. RSS is too noisy an instrument — the two runs'
    startup baselines (540 MiB and 385 MiB) differ by more than one model, which no one-copy
    story explains. Each run against itself is interpretable: before, the first question moved
    RSS 540 → 641 MiB; after, 385 → 380 MiB. A step, then no step. The controlling evidence for
    this gap is the load count, not the RSS delta.
36. **The embedder has the same trap, latent rather than live.** `local.ts` caches its pipeline
    in a module-level `let`, exactly the shape gap 35 was, and the built output puts that loader
    in three server graphs: the chunk shared by `/api/ask`, `/api/documents` and
    `/api/documents/reembed`; a second reached from `/api/admin/stats`; and the SSR chunk behind
    the page component. It nevertheless loads **once**, measured in both passes above, and the
    reason is not that the cache is sound — it is that only the first of those three ever calls
    `embed()`. `/api/admin/stats` and `embedding-notice.tsx` reach `getEmbedder()` only to read
    `embedder.model`, a plain string, which loads no model. So the duplication is real and
    currently costs nothing, and what stands between it and a second resident copy is which
    entry happens to call `embed()` first — a routing detail, not a guarantee. It was left as a
    module-level cache deliberately: moving it would be a change made on an argument, with
    nothing measurable to show for it, which is the thing gap 35 declined to do. If a future
    route in another graph embeds, this becomes gap 35 again, and the fix is the one line
    `ner.ts` now carries.

37. **Streaming buys back only the model's writing time, which on this model is a fifth of a
    second.** Measured, time to first token is 84-94% of the call: the model thinks for one to
    three seconds and then writes a short answer in 195-323 ms. Because the citations must
    complete before prose may start, that closing window is the entire perceived gain. It is a
    real gain and it is the difference between a dead screen and a live one, but the feature is
    far less dramatic than "streaming" suggests, and it would be more dramatic only by showing
    text the guard has not approved.

38. **`anthropic` and `gateway` do not stream.** Streaming lives in `providers/messages.ts`
    behind a `streaming` flag that only `openrouter` sets. Streaming is event framing, partial
    JSON, usage placement and abort behaviour all at once, and a wire-format document tells you
    least about exactly those — so shipping it for two endpoints this project has never run
    against a live service (gaps 1 and 2) would put verification-by-construction on the seam
    §5 calls the most important in the project. A deployment on either provider gets the whole
    answer as one delta. Turning it on later is one word, and the audit column follows the
    capability: `first_token_ms` is null for a provider that does not stream.

39. **~~A stream that dies mid-placeholder shows the placeholder syntax.~~ — withdrawn: it
    cannot.** The gap reasoned from the restorer alone, where it is true that `flush()` releases
    whatever suffix is still held. Checked against the path that would have to reach it: a
    dropped connection throws out of the `for await` in `rag/answer.ts`, so `flush()` is never
    called and the held `[PERSON_` is discarded with the request. It runs only when the stream
    ended cleanly *and* the finished reply validated — and then the held text is genuine prose
    that belongs on screen. Pinned by a test so a future `finally` around the flush cannot
    quietly reintroduce it. What remains is narrower and is not a leak: a model whose validated
    answer really does end in an unterminated `[` gets that character shown, because it is the
    model's own text.
40. **~~The race-window `budget_exhausted` lost its `retry-after` header.~~ — closed as far as it
    can be, which is not all the way.** The seconds were always in the event payload; nothing
    read them. The UI now does — *"Try again in about 7 hours"* — and a programmatic client reads
    `retryAfterSeconds` off the event, the same number the header would have carried.
    **What cannot be recovered is the header itself,** because the status line went out with the
    first byte, so a client written to look only at `retry-after` still sees nothing here. The
    honest statement is that this refusal is actionable in the payload and invisible in the
    headers. The pre-flight check still returns a real 429 with the header, so this remains the
    narrow race the reservation exists to lose safely.
41. **`readPartial` can be fooled by a `"citations"` key inside the answer text, if the model
    also reverses the field order — and, separately, by an `"answer"` key nested ahead of the
    real one, which needs no field reversal at all, because `valueStart` anchors on the FIRST
    occurrence of either key it finds.** The unconditional validation of the finished reply
    catches both: it compares what streamed against the finished reply's citations AND its prose,
    so a mis-scanned answer throws exactly like a mis-scanned citation set does. **The residual
    this gap used to carry — that the mis-scanned prose stayed on screen afterwards, labelled
    "cut short" but readable — is closed.** That throw is now typed, the orchestrator emits
    `retracted`, and the UI clears the prose, the sources and the privacy panel. What no protocol
    can undo is that the text was on screen while the stream ran: the forced probe's audit row
    puts the model's first token at 2,121 ms and the end of the call at 2,829 ms, so the
    withdrawn text was readable for something under 0.7 s. Retraction
    takes it off the screen; it cannot take it out of a reader who was quick. The mis-scan itself
    is still a mis-scan — `partialJson.ts` is a fast path with no nesting-aware parser behind it,
    by design — and the guarantee is that nothing it gets wrong survives to the end of the
    response.

42. **Nothing automated exercises the route, the UI, or `ai/call.ts`.** The streaming provider
    has a stub-server test (`test/openrouter-stream.test.ts`, the same shape as the gateway's),
    and the orchestrator, the partial-JSON scanner and the restorer are unit-tested. But
    `api/ask/route.ts`, `ask-form.tsx` and the audit wrapper are verified by execution probes
    and a measured pass against the running stack, recorded above, rather than by the suite.
    That now includes the retraction: the UI clearing what it had rendered was confirmed by
    forcing the contradiction in a local build, which is a manual pass and not a regression test.
    Same admission as gaps 23, 29 and 34, and the same residual risk: a future edit can break
    them and only another manual pass would catch it.

