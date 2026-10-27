CREATE TABLE "player_acquisition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"params" jsonb NOT NULL,
	"first_seen_at" timestamp with time zone,
	"landing_host" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_acquisition_player_id_unique" UNIQUE("player_id")
);
--> statement-breakpoint
ALTER TABLE "player_acquisition" ADD CONSTRAINT "player_acquisition_player_id_player_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."player"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "player_acquisition_params_idx" ON "player_acquisition" USING gin ("params");