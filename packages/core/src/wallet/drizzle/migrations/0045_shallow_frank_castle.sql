CREATE TYPE "public"."ledger_player_status" AS ENUM('active', 'dormant', 'self_excluded', 'suspended', 'closed');--> statement-breakpoint
CREATE TABLE "ledger_play_eligibility" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"rg_blocked" boolean NOT NULL,
	"rg_blocked_until" timestamp with time zone,
	"is_active" boolean NOT NULL,
	"banned" boolean NOT NULL,
	"ban_expires" timestamp with time zone,
	"status" "ledger_player_status",
	"version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
