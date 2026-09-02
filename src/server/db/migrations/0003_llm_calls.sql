CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "llm_calls_created_at_idx" ON "llm_calls" USING btree ("created_at");