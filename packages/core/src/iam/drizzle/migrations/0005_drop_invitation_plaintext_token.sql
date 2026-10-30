ALTER TABLE "admin_invitation" DROP CONSTRAINT "admin_invitation_token_unique";--> statement-breakpoint
DROP INDEX "admin_invitation_token_idx";--> statement-breakpoint
ALTER TABLE "admin_invitation" ALTER COLUMN "token_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_invitation" DROP COLUMN "token";