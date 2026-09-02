import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

import { EMBEDDING_DIMENSIONS } from "@/server/ai/types";

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
  },
  (table) => [
    index("chunks_owner_idx").on(table.ownerSub),
    index("chunks_document_idx").on(table.documentId),
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
