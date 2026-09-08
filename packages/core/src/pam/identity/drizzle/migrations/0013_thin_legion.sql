ALTER TABLE "user" ADD COLUMN "anti_phishing_code" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "anti_phishing_code_set_at" timestamp with time zone;