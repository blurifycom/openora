CREATE TABLE "ledger_user_limit" (
	"limit_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"period" text NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"currency" text,
	"changed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_user_limit_version" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ledger_user_limit_user_id_idx" ON "ledger_user_limit" USING btree ("user_id");