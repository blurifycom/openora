CREATE TABLE IF NOT EXISTS "player_donate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender_id" uuid NOT NULL,
	"sender_username" text NOT NULL,
	"recipient_id" uuid NOT NULL,
	"recipient_username" text NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"currency" text NOT NULL,
	"room_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "player_gift" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"sender_username" text NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"currency" text NOT NULL,
	"room_id" uuid,
	"claimed_by" uuid,
	"claimed_by_username" text,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "player_rain" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender_id" uuid NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"per_recipient" numeric(38, 18) NOT NULL,
	"currency" text NOT NULL,
	"room_id" uuid,
	"recipient_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "player_rain_receiver" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rain_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'player_rain_receiver_rain_id_player_rain_id_fk'
  ) THEN
    ALTER TABLE "player_rain_receiver"
      ADD CONSTRAINT "player_rain_receiver_rain_id_player_rain_id_fk"
      FOREIGN KEY ("rain_id") REFERENCES "public"."player_rain"("id")
      ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "player_donate" ALTER COLUMN "amount" SET DATA TYPE numeric(38, 18);
--> statement-breakpoint
ALTER TABLE "player_gift" ALTER COLUMN "amount" SET DATA TYPE numeric(38, 18);
--> statement-breakpoint
ALTER TABLE "player_rain" ALTER COLUMN "amount" SET DATA TYPE numeric(38, 18);
--> statement-breakpoint
ALTER TABLE "player_rain" ALTER COLUMN "per_recipient" SET DATA TYPE numeric(38, 18);
--> statement-breakpoint
ALTER TABLE "player_rain_receiver" ALTER COLUMN "amount" SET DATA TYPE numeric(38, 18);
