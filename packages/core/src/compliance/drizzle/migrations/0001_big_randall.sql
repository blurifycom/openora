ALTER TABLE "rg_exclusion" ADD COLUMN "is_permanent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_limit" ADD COLUMN "amount_cents" integer;--> statement-breakpoint
ALTER TABLE "user_limit" ADD COLUMN "minutes" integer;--> statement-breakpoint
ALTER TABLE "rg_exclusion" DROP COLUMN "permanent";--> statement-breakpoint
ALTER TABLE "user_limit" DROP COLUMN "amount";
