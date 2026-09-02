CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sub" text NOT NULL,
	"display_name" text,
	"email" text,
	"role_snapshot" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_sub_unique" UNIQUE("sub")
);
--> statement-breakpoint
CREATE INDEX "users_sub_idx" ON "users" USING btree ("sub");