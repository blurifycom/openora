ALTER TABLE "admin_invitation" ADD COLUMN "token_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_invitation_token_hash_uq" ON "admin_invitation" USING btree ("token_hash");