ALTER TABLE "player" ADD COLUMN "account_manager_id" uuid;--> statement-breakpoint
CREATE INDEX "player_account_manager_id_idx" ON "player" USING btree ("account_manager_id");