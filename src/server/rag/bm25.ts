import { sql } from "drizzle-orm";

import { db } from "@/server/db";

/**
 * The prose arm: BM25 over the `english` tsvector.
 *
 * WHY THIS EXISTS. A sentence embedder compresses a passage to 384 dimensions
 * and keeps its meaning. It does not keep the fact that the user wrote "the
 * arithmetic I actually use" in those words. Measured against the seed corpus,
 * five of fifteen prose questions were REFUSED — nothing cleared RAG_MIN_SCORE,
 * so the app said "Not found in your knowledge base." about documents it had
 * indexed. Two of the five were near-verbatim recalls of the user's own
 * headings, which for a personal knowledge base is not an edge case but the
 * house style of the questions.
 *
 * WHY BM25 IS COMPUTED HERE. Postgres has no BM25. `ts_rank_cd` has term
 * frequency and length normalisation but no IDF — no notion that "arithmetic"
 * is rarer than "the" — and IDF is the whole of what makes a prose ranker work.
 * So it is computed from the stored tsvector: `tf` from the positions array,
 * `df` across the owner's own chunks, `|d|` and `avgdl` from lexeme counts.
 * Rejected: a BM25 extension (ParadeDB), which is a new extension, a new base
 * image and a new way for `docker compose up` to fail offline, bought for a
 * corpus that answers in 20 ms without it; and a maintained statistics table,
 * which is a second write path that can drift from the content it describes.
 *
 * WHY ADMISSION IS COVERAGE AND NOT A SCORE FLOOR. This is the part that keeps
 * the citation guarantee intact. "Not found in your knowledge base." is
 * produced by retrieval returning nothing, before any model call, and a prose
 * arm matches something for almost every question. A floor on the BM25 score
 * would be a threshold invented for text ranks and tuned by feel — the thing
 * slices 10 and 13 both refused — and the refusal path would come to rest on
 * it. Coverage is a different kind of number: the share of the question's total
 * IDF mass that a chunk accounts for. It is dimensionless, lies in [0, 1], and
 * says something checkable — this chunk accounts for at least half of what you
 * actually asked about. A query term the corpus never contains counts in the
 * denominator at maximum IDF, so asking about something absent LOWERS coverage
 * rather than being quietly ignored.
 *
 * Measured separation on the seed corpus: eight answerable questions scored
 * 1.00, 1.00, 1.00, 0.79, 0.70, 0.69, 0.63 and 0.34; six unanswerable ones
 * scored 0.23, 0.16, 0.13, and three returned no rows at all because `english`
 * strips the stopwords and nothing survived that the corpus contains.
 */

/**
 * Canonical BM25 parameters. ADOPTED FROM THE LITERATURE, NOT TUNED HERE — that
 * distinction is the reason they are defensible. `k1` damps the reward for
 * repeating a term; `b` controls how much a long chunk is penalised for it.
 */
const K1 = 1.2;
const B = 0.75;

/**
 * The share of the question's IDF mass a chunk must account for to be admitted.
 *
 * It is a constant, and arbitrary in the way any threshold is: it sits in the
 * gap between 0.34 and 0.63 that one corpus of 53 chunks happened to show. It
 * is NOT an environment variable on purpose — the refusal path is not something
 * that should be tunable until a demo passes.
 */
const MIN_COVERAGE = 0.5;

/**
 * The three constants above are interpolated into the SQL as LITERALS rather
 * than bound as parameters. Two reasons, in this order:
 *
 * - Postgres cannot infer a type for a bare parameter inside an arithmetic
 *   expression such as `p.tf * ($1 + 1)`, and fails at plan time with "could
 *   not determine data type of parameter". A literal has a type.
 * - There is no injection surface to trade away: they are compile-time
 *   constants of our own, never derived from a request. Everything that DOES
 *   come from the request — the owner, the embedding model, the question, the
 *   query vector, the limit — stays a bound parameter below.
 */
const k1 = sql.raw(String(K1));
const b = sql.raw(String(B));
const minCoverage = sql.raw(String(MIN_COVERAGE));

/** A chunk the prose arm admitted. Same shape every arm returns. */
export interface ProseHit {
  id: string;
  documentId: string;
  filename: string;
  chunkIndex: number;
  content: string;
  score: number;
}

/**
 * The owner and embedding-model predicates are repeated here rather than
 * trusting another arm to have applied them: ownership belongs in the same
 * predicate as the search (CLAUDE.md §6), and a third query is a third place to
 * forget it. It has a consequence the other arms do not have — `df` and `avgdl`
 * are computed inside that same scope, so one user's corpus can never influence
 * another's ranking.
 *
 * `score` is the true cosine similarity, ungated, exactly as the lexical arm
 * reports it: a chunk the embedder scored poorly still leaves here with its
 * real number, so `score` means the same thing on every row retrieval returns.
 */
export async function retrieveByProse(params: {
  ownerSub: string;
  embeddingModel: string;
  question: string;
  queryVector: number[];
  limit: number;
}): Promise<ProseHit[]> {
  const { ownerSub, embeddingModel, question, queryVector, limit } = params;

  const result = await db.execute(sql`
    WITH scope AS (
      SELECT c.id, c.document_id, c.chunk_index, c.content,
             c.content_tsv_en AS tsv, c.embedding
      FROM chunks c
      WHERE c.owner_sub = ${ownerSub}
        AND c.embedding_model = ${embeddingModel}
    ),
    lengths AS (
      SELECT s.id, sum(coalesce(array_length(u.positions, 1), 1))::float8 AS dl
      FROM scope s, LATERAL unnest(s.tsv) u
      GROUP BY s.id
    ),
    -- N counts every chunk in scope, not only those that survived the
    -- tokenizer, so IDF is computed against the corpus the user actually has.
    stats AS (
      SELECT (SELECT count(*) FROM scope)::float8 AS n,
             (SELECT avg(dl) FROM lengths)::float8 AS avgdl
    ),
    qterms AS (
      SELECT DISTINCT u.lexeme FROM unnest(to_tsvector('english', ${question})) u
    ),
    postings AS (
      SELECT s.id, u.lexeme,
             coalesce(array_length(u.positions, 1), 1)::float8 AS tf
      FROM scope s, LATERAL unnest(s.tsv) u
      WHERE u.lexeme IN (SELECT lexeme FROM qterms)
    ),
    -- LEFT JOIN, so a term the corpus does not contain survives with df = 0 and
    -- lands in the denominator below at maximum IDF.
    df AS (
      SELECT q.lexeme, count(DISTINCT p.id)::float8 AS df
      FROM qterms q LEFT JOIN postings p ON p.lexeme = q.lexeme
      GROUP BY q.lexeme
    ),
    idf AS (
      SELECT d.lexeme, ln(1 + (st.n - d.df + 0.5) / (d.df + 0.5)) AS idf
      FROM df d CROSS JOIN stats st
    ),
    mass AS (SELECT sum(idf) AS total FROM idf),
    scored AS (
      SELECT p.id,
             sum(i.idf * (p.tf * (${k1} + 1))
                 / (p.tf + ${k1} * (1 - ${b} + ${b} * l.dl / st.avgdl))) AS bm25,
             sum(i.idf) / (SELECT total FROM mass) AS coverage
      FROM postings p
      JOIN idf i USING (lexeme)
      JOIN lengths l ON l.id = p.id
      CROSS JOIN stats st
      GROUP BY p.id
    )
    SELECT s.id, s.document_id, d.filename, s.chunk_index, s.content,
           1 - (s.embedding <=> ${JSON.stringify(queryVector)}::vector) AS score
    FROM scored sc
    JOIN scope s ON s.id = sc.id
    JOIN documents d ON d.id = s.document_id
    WHERE sc.coverage >= ${minCoverage}
    ORDER BY sc.bm25 DESC
    LIMIT ${limit}
  `);

  // node-postgres hands back untyped rows, and numerics can arrive as strings.
  return result.rows.map((row) => ({
    id: String(row.id),
    documentId: String(row.document_id),
    filename: String(row.filename),
    chunkIndex: Number(row.chunk_index),
    content: String(row.content),
    score: Number(row.score),
  }));
}
