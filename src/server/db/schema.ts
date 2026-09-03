import { sql, type SQL } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

import { EMBEDDING_DIMENSIONS } from "@/server/ai/types";

/**
 * Postgres' full-text type. Drizzle has no column type for it, and this is the
 * whole of what we need: a name for the type so the generated column below can
 * be declared and indexed.
 */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

/**
 * A local projection of the identity provider's subject — nothing more.
 *
 * There are deliberately no credentials here, and there never will be: the IdP
 * owns authentication (see CLAUDE.md §3). `role` is a snapshot of what the
 * token said at last sign-in, kept for display and for the admin view. It is
 * never the source of truth for authorization — the guard reads the token
 * claim on every request.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sub: text("sub").notNull().unique(),
    displayName: text("display_name"),
    email: text("email"),
    roleSnapshot: text("role_snapshot"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("users_sub_idx").on(table.sub)],
);

export type User = typeof users.$inferSelect;

/**
 * An uploaded document, owned by exactly one IdP subject.
 *
 * `content` keeps the extracted text so a citation can be rendered against the
 * original and offsets stay meaningful. Deleting a row cascades to its chunks
 * and their embeddings — the immediate hard delete promised in CLAUDE.md §7.
 */
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerSub: text("owner_sub").notNull(),
    filename: text("filename").notNull(),
    mediaType: text("media_type").notNull(),
    content: text("content").notNull(),
    byteSize: integer("byte_size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("documents_owner_idx").on(table.ownerSub)],
);

/**
 * A retrievable passage.
 *
 * `ownerSub` is denormalised from the parent document on purpose: retrieval
 * filters ownership in the same WHERE clause as the vector search, so a query
 * can never return another user's chunk even by mistake. §6 requires the filter
 * to live in SQL, and this keeps it in one predicate rather than a join.
 *
 * `embeddingModel` records which model produced the vector, because vectors
 * from different models are not comparable — retrieval filters on it so
 * changing the embedder degrades to "no results", never to silent nonsense.
 *
 * `contentTsv` is the lexical half of retrieval (see rag/retrieve.ts). It is
 * GENERATED, so it cannot drift from the content it indexes and there is no
 * write path to keep in step — and because Postgres computes a stored
 * generated column for existing rows when it is added, chunks indexed before
 * this column existed are searchable without re-uploading anything.
 *
 * `'simple'`, not `'english'`: the arm exists to match identifiers literally,
 * and stemming a part number can only lose information.
 */
export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    ownerSub: text("owner_sub").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    embeddingModel: text("embedding_model").notNull(),
    contentTsv: tsvector("content_tsv")
      .notNull()
      .generatedAlwaysAs((): SQL => sql`to_tsvector('simple', ${chunks.content})`),
  },
  (table) => [
    index("chunks_owner_idx").on(table.ownerSub),
    index("chunks_document_idx").on(table.documentId),
    index("chunks_content_tsv_idx").using("gin", table.contentTsv),
    // Vectors are unit length, so cosine distance is the right operator and
    // agrees with the dot product both providers produce.
    index("chunks_embedding_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
  ],
);

export type Document = typeof documents.$inferSelect;
export type Chunk = typeof chunks.$inferSelect;

/**
 * One row per call that left this process (CLAUDE.md §3).
 *
 * What is here is exactly the enumerated list — model, timestamp, token counts,
 * latency, outcome — and NOTHING else. In particular:
 *
 * - No prompt, no answer, no document text. Those are the things §3 forbids,
 *   and the table has nowhere to put them even by accident.
 * - No `owner_sub`. The record exists to answer "what did this app spend, and
 *   how did it behave", not "what did this person ask". Adding the subject
 *   would quietly turn a cost-and-latency table into a 30-day behavioural log
 *   of every user, which is a different thing with a different justification.
 *
 * Purged after RETENTION_AUDIT_DAYS by retention/purge.ts.
 */
export const llmCalls = pgTable(
  "llm_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    /** ok | timeout | error */
    outcome: text("outcome").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // The purge job scans by age, and it is the only query that scans this table.
  (table) => [index("llm_calls_created_at_idx").on(table.createdAt)],
);

export type LlmCall = typeof llmCalls.$inferSelect;

/**
 * How much one user has spent in the window in force. A counter, not a log.
 *
 * This is the table `llm_calls` deliberately refused to become, built so that
 * it cannot become it. The difference is not a policy, it is the shape:
 *
 * - ONE row per user per window, updated in place. There is no per-call row,
 *   so there is no ordering and no per-question timestamp — nothing here can be
 *   read back as "what did this person ask, and when".
 * - The only fields are totals. As with `llm_calls`, the type is the control:
 *   there is nowhere to put a prompt, an answer or a document.
 * - The retention job deletes every row that is not the current window, so
 *   within the hour this holds at most one row per user, for today.
 *
 * The cost is stated plainly in the README: the database now records that a
 * given user made N calls today. That is the minimum a ceiling can know, and
 * `deleteAccount` removes it with everything else belonging to the subject.
 */
export const userSpend = pgTable(
  "user_spend",
  {
    sub: text("sub").notNull(),
    /** Start of the UTC day. See server/spend.ts for why UTC. */
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    calls: integer("calls").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
  },
  // The composite key is what makes the upsert an increment rather than a new
  // row, and what stops the same user holding two counters for one window.
  (table) => [primaryKey({ columns: [table.sub, table.windowStart] })],
);

export type UserSpend = typeof userSpend.$inferSelect;
