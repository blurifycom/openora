CREATE TABLE "phone_verification_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"code_hash" text NOT NULL,
	"reauthenticated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_verification_session_userId_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "password_meets_policy" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "login_withdrawal_alerts_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "phone_verification_session" ADD CONSTRAINT "phone_verification_session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_verification_session" ADD CONSTRAINT "phone_verification_session_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "phone_verification_session_phone_idx" ON "phone_verification_session" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "phone_verification_session_session_id_idx" ON "phone_verification_session" USING btree ("session_id");