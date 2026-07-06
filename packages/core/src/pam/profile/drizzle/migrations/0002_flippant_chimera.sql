CREATE TYPE "public"."kyc_status" AS ENUM('not_started', 'pending', 'verified', 'rejected', 'resubmission_requested', 'manually_overridden');--> statement-breakpoint
CREATE TYPE "public"."player_status" AS ENUM('active', 'dormant', 'self_excluded', 'suspended', 'closed');--> statement-breakpoint
ALTER TABLE "player" ALTER COLUMN "status" SET DEFAULT 'active'::"public"."player_status";--> statement-breakpoint
ALTER TABLE "player" ALTER COLUMN "status" SET DATA TYPE "public"."player_status" USING "status"::"public"."player_status";--> statement-breakpoint
ALTER TABLE "player" ALTER COLUMN "kyc_status" SET DEFAULT 'pending'::"public"."kyc_status";--> statement-breakpoint
ALTER TABLE "player" ALTER COLUMN "kyc_status" SET DATA TYPE "public"."kyc_status" USING "kyc_status"::"public"."kyc_status";--> statement-breakpoint
ALTER TABLE "player" DROP COLUMN "language";--> statement-breakpoint
ALTER TABLE "player" DROP COLUMN "theme";
