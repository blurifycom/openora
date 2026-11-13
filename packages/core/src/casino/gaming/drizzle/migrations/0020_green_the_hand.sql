CREATE TABLE "ledger_game" (
	"game_id" uuid PRIMARY KEY NOT NULL,
	"provider_id" uuid NOT NULL,
	"game_type" "game_type" NOT NULL,
	"version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "game_round" DROP CONSTRAINT "game_round_game_id_game_id_fk";
--> statement-breakpoint
ALTER TABLE "game" ADD COLUMN "ledger_version" integer DEFAULT 0 NOT NULL;