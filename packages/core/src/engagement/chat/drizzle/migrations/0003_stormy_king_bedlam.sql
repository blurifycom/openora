CREATE TABLE "chat_user_ignore" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ignorer_id" uuid NOT NULL,
	"ignored_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_user_ignore_pair_key" ON "chat_user_ignore" USING btree ("ignorer_id","ignored_id");--> statement-breakpoint
CREATE INDEX "chat_user_ignore_ignorer_idx" ON "chat_user_ignore" USING btree ("ignorer_id");
