CREATE TABLE "SportsbookBet" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"userId" text NOT NULL,
	"eventId" text NOT NULL,
	"selectionId" text NOT NULL,
	"stake" real NOT NULL,
	"oddsAtPlacement" real NOT NULL,
	"potentialReturn" real NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "SportsbookEvent" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"sport" text NOT NULL,
	"league" text NOT NULL,
	"homeTeam" text NOT NULL,
	"awayTeam" text NOT NULL,
	"startsAt" timestamp NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "SportsbookSelection" (
	"id" text PRIMARY KEY NOT NULL,
	"eventId" text NOT NULL,
	"label" text NOT NULL,
	"odds" real NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "SportsbookSelection" ADD CONSTRAINT "SportsbookSelection_eventId_SportsbookEvent_id_fk" FOREIGN KEY ("eventId") REFERENCES "public"."SportsbookEvent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sportsbook_bet_tenantId_idx" ON "SportsbookBet" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "sportsbook_bet_userId_idx" ON "SportsbookBet" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "sportsbook_event_tenantId_idx" ON "SportsbookEvent" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "sportsbook_selection_eventId_idx" ON "SportsbookSelection" USING btree ("eventId");