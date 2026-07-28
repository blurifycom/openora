ALTER TYPE "public"."tag_key" ADD VALUE 'basic_kyc_needed' BEFORE 'test_account';--> statement-breakpoint
ALTER TYPE "public"."tag_key" ADD VALUE 'advanced_kyc_needed' BEFORE 'test_account';
