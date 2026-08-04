CREATE TABLE "player_donate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender_id" uuid NOT NULL,
	"sender_username" text NOT NULL,
	"recipient_id" uuid NOT NULL,
	"recipient_username" text NOT NULL,
	"amount" numeric(18, 8) NOT NULL,
	"currency" text NOT NULL,
	"room_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_gift" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"sender_username" text NOT NULL,
	"amount" numeric(18, 8) NOT NULL,
	"currency" text NOT NULL,
	"room_id" uuid,
	"claimed_by" uuid,
	"claimed_by_username" text,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_rain" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender_id" uuid NOT NULL,
	"amount" numeric(18, 8) NOT NULL,
	"per_recipient" numeric(18, 8) NOT NULL,
	"currency" text NOT NULL,
	"room_id" uuid,
	"recipient_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_rain_receiver" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rain_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"amount" numeric(18, 8) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "player_rain_receiver" ADD CONSTRAINT "player_rain_receiver_rain_id_player_rain_id_fk" FOREIGN KEY ("rain_id") REFERENCES "public"."player_rain"("id") ON DELETE no action ON UPDATE no action;