CREATE TABLE "admin_trusted_device" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_hash" text NOT NULL,
	"label" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "failed_two_factor_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "two_factor_lockout_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "two_factor_lockout_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "last_failed_two_factor_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_trusted_device" ADD CONSTRAINT "admin_trusted_device_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_trusted_device_user_hash_idx" ON "admin_trusted_device" USING btree ("user_id","device_hash");--> statement-breakpoint
CREATE INDEX "admin_trusted_device_user_id_idx" ON "admin_trusted_device" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "admin_trusted_device_expires_at_idx" ON "admin_trusted_device" USING btree ("expires_at");