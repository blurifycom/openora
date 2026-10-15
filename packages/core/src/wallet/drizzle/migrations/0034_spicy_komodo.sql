CREATE TABLE "wallet_on_ramp_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"external_id" text,
	"idempotency_key" uuid NOT NULL,
	"checkout_url" text,
	"fiat_amount" numeric(38, 18) NOT NULL,
	"fiat_currency" text NOT NULL,
	"currency" text NOT NULL,
	"network" text NOT NULL,
	"wallet_address" text NOT NULL,
	"wallet_tag" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"crypto_amount" numeric(38, 18),
	"tx_hash" text,
	"gateway_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_on_ramp_order_status_check" CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled', 'expired', 'refunded'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_on_ramp_order_external_id_idx" ON "wallet_on_ramp_order" USING btree ("external_id") WHERE "wallet_on_ramp_order"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_on_ramp_order_user_id_idempotency_key_idx" ON "wallet_on_ramp_order" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "wallet_on_ramp_order_user_id_status_idx" ON "wallet_on_ramp_order" USING btree ("user_id","status");