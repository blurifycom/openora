-- Migrate tag_rule.tag_key (enum) → tag_rule.tag_id (uuid FK to tag.id).
-- drizzle-kit generated a bare RENAME which leaves the enum type in place and
-- cannot satisfy the uuid FK. We replace it with the correct sequence:
-- add nullable uuid column, back-fill from tag table, drop old enum column,
-- enforce NOT NULL, then add FK + unique constraints.

ALTER TABLE "tag_rule" ADD COLUMN "tag_id" uuid;--> statement-breakpoint
UPDATE "tag_rule" SET "tag_id" = (SELECT "id" FROM "tag" WHERE "tag"."key"::text = "tag_rule"."tag_key"::text);--> statement-breakpoint
ALTER TABLE "tag_rule" DROP CONSTRAINT "tag_rule_tag_key_unique";--> statement-breakpoint
ALTER TABLE "tag_rule" DROP COLUMN "tag_key";--> statement-breakpoint
ALTER TABLE "tag_rule" ALTER COLUMN "tag_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tag_rule" ADD CONSTRAINT "tag_rule_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_rule" ADD CONSTRAINT "tag_rule_tagId_unique" UNIQUE("tag_id");
