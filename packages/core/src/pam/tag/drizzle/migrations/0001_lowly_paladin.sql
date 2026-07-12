ALTER TABLE "tag_rule" ADD COLUMN "threshold_cents" integer;--> statement-breakpoint
ALTER TABLE "tag_rule" DROP COLUMN "threshold_amount";
