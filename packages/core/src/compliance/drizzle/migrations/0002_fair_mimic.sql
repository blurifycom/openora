ALTER TABLE "user_limit" ADD COLUMN "amount" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "user_limit" DROP COLUMN "amount_cents";
