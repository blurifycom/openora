CREATE TYPE "public"."sportsbook_bet_result" AS ENUM('won', 'lost', 'void', 'half_won', 'half_lost', 'cashed_out');--> statement-breakpoint
CREATE TYPE "public"."sportsbook_bet_status" AS ENUM('reserved', 'accepted', 'cancelled', 'settled');--> statement-breakpoint
CREATE TYPE "public"."sportsbook_cancel_reason" AS ENUM('rejected', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."sportsbook_debt_action_kind" AS ENUM('collected', 'written_off');--> statement-breakpoint
CREATE TYPE "public"."sportsbook_debt_shortfall_type" AS ENUM('win_reversal', 'bet');--> statement-breakpoint
CREATE TYPE "public"."sportsbook_debt_status" AS ENUM('open', 'cleared', 'written_off');--> statement-breakpoint
CREATE TYPE "public"."sportsbook_finding_kind" AS ENUM('fingerprint_mismatch', 'payout_above_potential', 'invalid_amount', 'debt_recorded', 'reserve_unresolved', 'settlement_overdue', 'provider_mismatch');--> statement-breakpoint
CREATE TYPE "public"."sportsbook_finding_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."sportsbook_transaction_kind" AS ENUM('reserve', 'confirm', 'cancel', 'settle', 'reopen');--> statement-breakpoint
CREATE TABLE "sportsbook_bet" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_bet_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"currency_decimals" integer NOT NULL,
	"status" "sportsbook_bet_status" NOT NULL,
	"result" "sportsbook_bet_result",
	"stake" numeric(38, 18) NOT NULL,
	"potential_payout" numeric(38, 18) NOT NULL,
	"payout_total" numeric(38, 18) DEFAULT '0' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"legs" jsonb NOT NULL,
	"last_leg_starts_at" timestamp with time zone NOT NULL,
	"reconcile_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sportsbook_bet_stake_positive_check" CHECK ("sportsbook_bet"."stake" > 0),
	CONSTRAINT "sportsbook_bet_payout_total_non_negative_check" CHECK ("sportsbook_bet"."payout_total" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sportsbook_bet_transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_tx_id" text NOT NULL,
	"provider_bet_id" text NOT NULL,
	"bet_id" uuid,
	"user_id" uuid,
	"kind" "sportsbook_transaction_kind" NOT NULL,
	"amount" numeric(38, 18) DEFAULT '0' NOT NULL,
	"potential_payout" numeric(38, 18),
	"legs" jsonb,
	"bet_version" integer DEFAULT 0 NOT NULL,
	"fingerprint" text NOT NULL,
	"result" "sportsbook_bet_result",
	"cancel_reason" "sportsbook_cancel_reason",
	"wallet_transaction_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"balance_after" numeric(38, 18),
	"currency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sportsbook_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton_key" text DEFAULT 'global' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"suspended" boolean DEFAULT false NOT NULL,
	"currencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blocked_countries" text[] DEFAULT '{}'::text[] NOT NULL,
	"reserve_timeout_seconds" integer DEFAULT 300 NOT NULL,
	"settlement_grace_minutes" integer DEFAULT 1440 NOT NULL,
	"session_ttl_minutes" integer DEFAULT 240 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sportsbook_config_singleton_key_unique" UNIQUE("singleton_key")
);
--> statement-breakpoint
CREATE TABLE "sportsbook_debt_action" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"debt_id" uuid NOT NULL,
	"action" "sportsbook_debt_action_kind" NOT NULL,
	"reason" text,
	"result" jsonb NOT NULL,
	"actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sportsbook_debt_action_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "sportsbook_debt_shortfall" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"debt_id" uuid NOT NULL,
	"bet_id" uuid NOT NULL,
	"type" "sportsbook_debt_shortfall_type" NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sportsbook_debt_shortfall_amount_check" CHECK ("sportsbook_debt_shortfall"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "sportsbook_player_debt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"owed" numeric(38, 18) DEFAULT '0' NOT NULL,
	"collected" numeric(38, 18) DEFAULT '0' NOT NULL,
	"written_off" numeric(38, 18) DEFAULT '0' NOT NULL,
	"outstanding" numeric(38, 18) DEFAULT '0' NOT NULL,
	"status" "sportsbook_debt_status" DEFAULT 'open' NOT NULL,
	"written_off_by" uuid,
	"written_off_reason" text,
	"written_off_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sportsbook_player_debt_outstanding_check" CHECK ("sportsbook_player_debt"."outstanding" = "sportsbook_player_debt"."owed" - "sportsbook_player_debt"."collected" - "sportsbook_player_debt"."written_off" AND "sportsbook_player_debt"."outstanding" >= 0 AND "sportsbook_player_debt"."owed" >= 0 AND "sportsbook_player_debt"."collected" >= 0 AND "sportsbook_player_debt"."written_off" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sportsbook_player_restriction" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"restricted_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sportsbook_reconciliation_finding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "sportsbook_finding_kind" NOT NULL,
	"provider" text,
	"bet_id" uuid,
	"user_id" uuid,
	"dedupe_key" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "sportsbook_finding_status" DEFAULT 'open' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sportsbook_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"currency" text NOT NULL,
	"country_code" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"provider_revoked_at" timestamp with time zone,
	"provider_opened_at" timestamp with time zone,
	"provider_revoke_attempted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sportsbook_bet" ADD CONSTRAINT "sportsbook_bet_session_id_sportsbook_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sportsbook_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sportsbook_bet_transaction" ADD CONSTRAINT "sportsbook_bet_transaction_bet_id_sportsbook_bet_id_fk" FOREIGN KEY ("bet_id") REFERENCES "public"."sportsbook_bet"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sportsbook_debt_action" ADD CONSTRAINT "sportsbook_debt_action_debt_id_sportsbook_player_debt_id_fk" FOREIGN KEY ("debt_id") REFERENCES "public"."sportsbook_player_debt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sportsbook_debt_shortfall" ADD CONSTRAINT "sportsbook_debt_shortfall_debt_id_sportsbook_player_debt_id_fk" FOREIGN KEY ("debt_id") REFERENCES "public"."sportsbook_player_debt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sportsbook_debt_shortfall" ADD CONSTRAINT "sportsbook_debt_shortfall_bet_id_sportsbook_bet_id_fk" FOREIGN KEY ("bet_id") REFERENCES "public"."sportsbook_bet"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sportsbook_reconciliation_finding" ADD CONSTRAINT "sportsbook_reconciliation_finding_bet_id_sportsbook_bet_id_fk" FOREIGN KEY ("bet_id") REFERENCES "public"."sportsbook_bet"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sportsbook_bet_provider_provider_bet_id_idx" ON "sportsbook_bet" USING btree ("provider","provider_bet_id");--> statement-breakpoint
CREATE INDEX "sportsbook_bet_user_id_created_at_idx" ON "sportsbook_bet" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "sportsbook_bet_created_at_idx" ON "sportsbook_bet" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sportsbook_bet_status_created_at_idx" ON "sportsbook_bet" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "sportsbook_bet_reserved_created_at_idx" ON "sportsbook_bet" USING btree ("created_at","id") WHERE "sportsbook_bet"."status" = 'reserved' and "sportsbook_bet"."reconcile_attempts" < 3;--> statement-breakpoint
CREATE INDEX "sportsbook_bet_accepted_last_leg_starts_at_idx" ON "sportsbook_bet" USING btree ("last_leg_starts_at","id") WHERE "sportsbook_bet"."status" = 'accepted';--> statement-breakpoint
CREATE UNIQUE INDEX "sportsbook_bet_transaction_provider_provider_tx_id_idx" ON "sportsbook_bet_transaction" USING btree ("provider","provider_tx_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sportsbook_bet_transaction_bet_origin_idx" ON "sportsbook_bet_transaction" USING btree ("provider","provider_bet_id") WHERE "sportsbook_bet_transaction"."kind" = 'reserve' OR "sportsbook_bet_transaction"."bet_id" IS NULL;--> statement-breakpoint
CREATE INDEX "sportsbook_bet_transaction_bet_id_created_at_idx" ON "sportsbook_bet_transaction" USING btree ("bet_id","created_at");--> statement-breakpoint
CREATE INDEX "sportsbook_debt_shortfall_debt_id_seq_idx" ON "sportsbook_debt_shortfall" USING btree ("debt_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "sportsbook_player_debt_user_id_currency_idx" ON "sportsbook_player_debt" USING btree ("user_id","currency");--> statement-breakpoint
CREATE INDEX "sportsbook_player_debt_status_updated_at_idx" ON "sportsbook_player_debt" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "sportsbook_player_debt_updated_at_idx" ON "sportsbook_player_debt" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sportsbook_reconciliation_finding_open_dedupe_key_idx" ON "sportsbook_reconciliation_finding" USING btree ("dedupe_key") WHERE "sportsbook_reconciliation_finding"."status" = 'open';--> statement-breakpoint
CREATE INDEX "sportsbook_reconciliation_finding_status_created_at_idx" ON "sportsbook_reconciliation_finding" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "sportsbook_reconciliation_finding_created_at_idx" ON "sportsbook_reconciliation_finding" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "sportsbook_reconciliation_finding_bet_id_kind_idx" ON "sportsbook_reconciliation_finding" USING btree ("bet_id","kind");--> statement-breakpoint
CREATE INDEX "sportsbook_session_user_id_live_idx" ON "sportsbook_session" USING btree ("user_id","expires_at") WHERE "sportsbook_session"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "sportsbook_session_expires_at_live_idx" ON "sportsbook_session" USING btree ("expires_at") WHERE "sportsbook_session"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "sportsbook_session_unacknowledged_expires_at_id_idx" ON "sportsbook_session" USING btree ("expires_at","id") WHERE "sportsbook_session"."revoked_at" IS NOT NULL AND "sportsbook_session"."provider_revoked_at" IS NULL;