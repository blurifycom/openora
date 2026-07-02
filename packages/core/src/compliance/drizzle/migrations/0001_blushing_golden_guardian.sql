CREATE TABLE "kyc_verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"reference_id" text NOT NULL,
	"status" text NOT NULL,
	"document_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decision_reason" text,
	"triggered_by" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "kyc_verification_user_id_created_at_idx" ON "kyc_verification" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "kyc_verification_reference_id_idx" ON "kyc_verification" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "kyc_verification_status_idx" ON "kyc_verification" USING btree ("status");
