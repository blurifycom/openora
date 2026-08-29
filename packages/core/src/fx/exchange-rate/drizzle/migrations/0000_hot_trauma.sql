CREATE TABLE "exchange_rate_quote" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_currency" text NOT NULL,
	"quote_currency" text NOT NULL,
	"rate" numeric(38, 18) NOT NULL,
	"provider_as_of" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "exchange_rate_quote_base_quote_idx" ON "exchange_rate_quote" USING btree ("base_currency","quote_currency");