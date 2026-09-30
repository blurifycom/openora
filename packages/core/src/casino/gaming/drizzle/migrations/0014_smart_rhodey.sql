CREATE TABLE "game_favorite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "game_favorite" ADD CONSTRAINT "game_favorite_game_id_game_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."game"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "game_favorite_user_id_game_id_key" ON "game_favorite" USING btree ("user_id","game_id");--> statement-breakpoint
CREATE INDEX "game_favorite_user_id_created_at_idx" ON "game_favorite" USING btree ("user_id","created_at");