CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"owner_sub" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"embedding" vector(384) NOT NULL,
	"embedding_model" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_sub" text NOT NULL,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"content" text NOT NULL,
	"byte_size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_owner_idx" ON "chunks" USING btree ("owner_sub");--> statement-breakpoint
CREATE INDEX "chunks_document_idx" ON "chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "chunks_embedding_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "documents_owner_idx" ON "documents" USING btree ("owner_sub");