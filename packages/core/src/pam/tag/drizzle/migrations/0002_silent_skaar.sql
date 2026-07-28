ALTER TYPE "public"."tag_key" ADD VALUE 'dormant_high_roller';--> statement-breakpoint
ALTER TYPE "public"."tag_key" ADD VALUE 'withdrawal_review';--> statement-breakpoint
CREATE INDEX "player_tag_tag_id_idx" ON "player_tag" USING btree ("tag_id") WHERE "player_tag"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "player_tag_active_key" ON "player_tag" USING btree ("tag_id","player_id") WHERE "player_tag"."removed_at" is null;
