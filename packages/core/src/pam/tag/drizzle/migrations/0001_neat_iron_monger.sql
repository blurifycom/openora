ALTER TABLE "tag_rule" ADD COLUMN "threshold" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "tag_rule" DROP COLUMN "threshold_amount";
