ALTER TABLE "user" ADD COLUMN "username" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "terms_version" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "age_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "registration_ip" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "registration_user_agent" text;--> statement-breakpoint
CREATE UNIQUE INDEX "user_username_unique" ON "user" USING btree (lower("username")) WHERE "user"."username" is not null;