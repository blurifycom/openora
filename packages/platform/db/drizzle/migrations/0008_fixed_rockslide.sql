CREATE TABLE "admin_invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"email" text NOT NULL,
	"roleId" text NOT NULL,
	"token" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"acceptedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "admin_invitation_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "admin_role" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_role_assignment" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"userId" text NOT NULL,
	"roleId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_role_permission" (
	"id" text PRIMARY KEY NOT NULL,
	"roleId" text NOT NULL,
	"resource" text NOT NULL,
	"action" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_invitation" ADD CONSTRAINT "admin_invitation_roleId_admin_role_id_fk" FOREIGN KEY ("roleId") REFERENCES "public"."admin_role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_role_assignment" ADD CONSTRAINT "admin_role_assignment_roleId_admin_role_id_fk" FOREIGN KEY ("roleId") REFERENCES "public"."admin_role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_role_permission" ADD CONSTRAINT "admin_role_permission_roleId_admin_role_id_fk" FOREIGN KEY ("roleId") REFERENCES "public"."admin_role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_invitation_tenantId_idx" ON "admin_invitation" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "admin_invitation_token_idx" ON "admin_invitation" USING btree ("token");--> statement-breakpoint
CREATE INDEX "admin_role_tenantId_idx" ON "admin_role" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "admin_role_assignment_tenantId_userId_idx" ON "admin_role_assignment" USING btree ("tenantId","userId");--> statement-breakpoint
CREATE INDEX "admin_role_permission_roleId_idx" ON "admin_role_permission" USING btree ("roleId");