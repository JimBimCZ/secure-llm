CREATE TABLE "user_spend" (
	"sub" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "user_spend_sub_window_start_pk" PRIMARY KEY("sub","window_start")
);
