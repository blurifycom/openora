ALTER TABLE "admin_invitation" DROP CONSTRAINT "admin_invitation_roleId_admin_role_id_fk";
--> statement-breakpoint
ALTER TABLE "admin_role_assignment" DROP CONSTRAINT "admin_role_assignment_roleId_admin_role_id_fk";
--> statement-breakpoint
ALTER TABLE "admin_role_permission" DROP CONSTRAINT "admin_role_permission_roleId_admin_role_id_fk";
--> statement-breakpoint
ALTER TABLE "admin_invitation" ALTER COLUMN "expiresAt" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_invitation" ALTER COLUMN "acceptedAt" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_invitation" ALTER COLUMN "createdAt" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_invitation" ALTER COLUMN "createdAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "admin_role" ALTER COLUMN "createdAt" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_role" ALTER COLUMN "createdAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "admin_role_assignment" ALTER COLUMN "createdAt" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_role_assignment" ALTER COLUMN "createdAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "admin_role_permission" ALTER COLUMN "createdAt" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_role_permission" ALTER COLUMN "createdAt" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "admin_role" ADD COLUMN "key" text;--> statement-breakpoint
ALTER TABLE "admin_role" ADD COLUMN "isSystem" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_role" ADD COLUMN "isSuperAdmin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_role_permission" ADD COLUMN "level" text DEFAULT 'no_access' NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_role_permission" ADD COLUMN "updatedAt" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_invitation" ADD CONSTRAINT "admin_invitation_roleId_admin_role_id_fk" FOREIGN KEY ("roleId") REFERENCES "public"."admin_role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_role_assignment" ADD CONSTRAINT "admin_role_assignment_roleId_admin_role_id_fk" FOREIGN KEY ("roleId") REFERENCES "public"."admin_role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_role_permission" ADD CONSTRAINT "admin_role_permission_roleId_admin_role_id_fk" FOREIGN KEY ("roleId") REFERENCES "public"."admin_role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_role_key_uq" ON "admin_role" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_role_assignment_uq" ON "admin_role_assignment" USING btree ("userId","roleId");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_role_permission_role_resource_uq" ON "admin_role_permission" USING btree ("roleId","resource");--> statement-breakpoint
ALTER TABLE "admin_role_permission" DROP COLUMN "action";
