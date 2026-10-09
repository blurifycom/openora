CREATE TYPE "public"."mcp_token_revoke_reason" AS ENUM('manual', 'admin_disabled', 'admin_role_removed', 'sessions_revoked', 'revoked_all');--> statement-breakpoint
CREATE TABLE "mcp_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" "mcp_token_revoke_reason",
	"last_used_at" timestamp with time zone,
	"call_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_token_token_hash_uq" ON "mcp_token" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "mcp_token_admin_user_id_idx" ON "mcp_token" USING btree ("admin_user_id");