CREATE TYPE "public"."audit_actor_type" AS ENUM('player', 'admin', 'system');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"actorId" text,
	"actorType" "audit_actor_type" NOT NULL,
	"action" text NOT NULL,
	"resourceType" text NOT NULL,
	"resourceId" text,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"userAgent" text,
	"correlationId" text,
	"seq" bigserial NOT NULL,
	"prevHash" text,
	"hash" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_log_tenantId_idx" ON "audit_log" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "audit_log_actorId_idx" ON "audit_log" USING btree ("actorId");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_log_resourceType_idx" ON "audit_log" USING btree ("resourceType");--> statement-breakpoint
CREATE INDEX "audit_log_createdAt_idx" ON "audit_log" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_seq_idx" ON "audit_log" USING btree ("tenantId","seq");