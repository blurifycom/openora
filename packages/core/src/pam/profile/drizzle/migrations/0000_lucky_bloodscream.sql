CREATE TABLE "player" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"country" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"kyc_status" text DEFAULT 'pending' NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"total_wagered" numeric(18, 2) DEFAULT '0' NOT NULL,
	"total_deposits" numeric(18, 2) DEFAULT '0' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "player_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE INDEX "player_status_idx" ON "player" USING btree ("status");--> statement-breakpoint
CREATE INDEX "player_created_at_idx" ON "player" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "player_name_trgm_idx" ON "player" USING gin ("display_name" gin_trgm_ops);
