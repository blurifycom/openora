CREATE TABLE "aggregator_provider" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"config" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "aggregator_provider_tenantId_slug_key" ON "aggregator_provider" USING btree ("tenantId","slug");