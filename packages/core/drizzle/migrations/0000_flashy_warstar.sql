CREATE TYPE "public"."audit_actor_type" AS ENUM('player', 'admin', 'system');--> statement-breakpoint
CREATE TYPE "public"."BonusType" AS ENUM('welcome', 'deposit_match', 'free_spins', 'custom');--> statement-breakpoint
CREATE TYPE "public"."UserBonusStatus" AS ENUM('pending', 'active', 'completed', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."GameRoundStatus" AS ENUM('active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."WalletTransactionStatus" AS ENUM('pending', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."WalletTransactionType" AS ENUM('deposit', 'withdrawal', 'bet', 'win');--> statement-breakpoint
CREATE TABLE "event_outbox" (
	"eventId" text PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"schemaVersion" integer DEFAULT 1 NOT NULL,
	"traceId" text,
	"orderingKey" text,
	"occurredAt" timestamp with time zone NOT NULL,
	"publishedAt" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actorId" text,
	"actorType" "audit_actor_type" NOT NULL,
	"action" text NOT NULL,
	"resourceType" text NOT NULL,
	"resourceId" text,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"userAgent" text,
	"correlationId" text,
	"result" text,
	"seq" bigserial NOT NULL,
	"prevHash" text,
	"hash" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bonus" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "BonusType" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"amount" numeric NOT NULL,
	"minDeposit" numeric DEFAULT '0' NOT NULL,
	"wagerMultiplier" integer DEFAULT 1 NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"expiresAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_bonus" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"bonusId" uuid NOT NULL,
	"status" "UserBonusStatus" DEFAULT 'pending' NOT NULL,
	"awardedAmount" numeric NOT NULL,
	"wageredAmount" numeric DEFAULT '0' NOT NULL,
	"wagerRequirement" numeric NOT NULL,
	"expiresAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChatMessage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"roomId" uuid,
	"userId" uuid NOT NULL,
	"username" text NOT NULL,
	"content" text NOT NULL,
	"isDeleted" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChatRoom" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"isPublic" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "banner" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"placement" text NOT NULL,
	"title" text NOT NULL,
	"imageUrl" text NOT NULL,
	"linkUrl" text,
	"isActive" boolean DEFAULT true NOT NULL,
	"sortOrder" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"publishedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "page_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "geo_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"countryCode" text NOT NULL,
	"action" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "geo_rule_countryCode_unique" UNIQUE("countryCode")
);
--> statement-breakpoint
CREATE TABLE "user_limit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"type" text NOT NULL,
	"amount" real NOT NULL,
	"period" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Game" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"category" text NOT NULL,
	"thumbnailUrl" text,
	"isActive" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "GameRound" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gameId" uuid NOT NULL,
	"userId" uuid NOT NULL,
	"status" "GameRoundStatus" DEFAULT 'active' NOT NULL,
	"betAmount" numeric DEFAULT '0' NOT NULL,
	"winAmount" numeric DEFAULT '0' NOT NULL,
	"currency" text NOT NULL,
	"startedAt" timestamp DEFAULT now() NOT NULL,
	"endedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "admin_invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"roleId" uuid NOT NULL,
	"token" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"acceptedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "admin_invitation_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "admin_role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_role_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"roleId" uuid NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_role_permission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"roleId" uuid NOT NULL,
	"resource" text NOT NULL,
	"action" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" uuid NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp,
	"refreshTokenExpiresAt" timestamp,
	"scope" text,
	"password" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"token" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" uuid NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "twoFactor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secret" text NOT NULL,
	"backupCodes" text NOT NULL,
	"userId" uuid NOT NULL,
	"verified" boolean DEFAULT true
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'player' NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"banned" boolean DEFAULT false,
	"banReason" text,
	"banExpires" timestamp,
	"twoFactorEnabled" boolean DEFAULT false,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "FeaturedSlot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gameId" uuid NOT NULL,
	"title" text NOT NULL,
	"placement" text NOT NULL,
	"sortOrder" integer DEFAULT 0 NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "LobbyCategory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"sortOrder" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "LobbyCategoryGame" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"categoryId" uuid NOT NULL,
	"gameId" uuid NOT NULL,
	"sortOrder" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"readAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"displayName" text NOT NULL,
	"country" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"kycStatus" text DEFAULT 'pending' NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"totalWagered" numeric(18, 2) DEFAULT '0' NOT NULL,
	"totalDeposits" numeric(18, 2) DEFAULT '0' NOT NULL,
	"lastSeenAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "player_userId_unique" UNIQUE("userId")
);
--> statement-breakpoint
CREATE TABLE "wallet" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"balance" numeric DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "wallet_userId_unique" UNIQUE("userId")
);
--> statement-breakpoint
CREATE TABLE "wallet_transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"walletId" uuid NOT NULL,
	"type" "WalletTransactionType" NOT NULL,
	"amount" numeric NOT NULL,
	"currency" text NOT NULL,
	"status" "WalletTransactionStatus" DEFAULT 'pending' NOT NULL,
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_bonus" ADD CONSTRAINT "user_bonus_bonusId_bonus_id_fk" FOREIGN KEY ("bonusId") REFERENCES "public"."bonus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_roomId_ChatRoom_id_fk" FOREIGN KEY ("roomId") REFERENCES "public"."ChatRoom"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "GameRound" ADD CONSTRAINT "GameRound_gameId_Game_id_fk" FOREIGN KEY ("gameId") REFERENCES "public"."Game"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_invitation" ADD CONSTRAINT "admin_invitation_roleId_admin_role_id_fk" FOREIGN KEY ("roleId") REFERENCES "public"."admin_role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_role_assignment" ADD CONSTRAINT "admin_role_assignment_roleId_admin_role_id_fk" FOREIGN KEY ("roleId") REFERENCES "public"."admin_role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_role_permission" ADD CONSTRAINT "admin_role_permission_roleId_admin_role_id_fk" FOREIGN KEY ("roleId") REFERENCES "public"."admin_role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "twoFactor" ADD CONSTRAINT "twoFactor_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "LobbyCategoryGame" ADD CONSTRAINT "LobbyCategoryGame_categoryId_LobbyCategory_id_fk" FOREIGN KEY ("categoryId") REFERENCES "public"."LobbyCategory"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transaction" ADD CONSTRAINT "wallet_transaction_walletId_wallet_id_fk" FOREIGN KEY ("walletId") REFERENCES "public"."wallet"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_outbox_pending_idx" ON "event_outbox" USING btree ("publishedAt","occurredAt");--> statement-breakpoint
CREATE INDEX "audit_log_actorId_idx" ON "audit_log" USING btree ("actorId");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_log_resourceType_idx" ON "audit_log" USING btree ("resourceType");--> statement-breakpoint
CREATE INDEX "audit_log_createdAt_idx" ON "audit_log" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "audit_log_seq_idx" ON "audit_log" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "bonus_isActive_idx" ON "bonus" USING btree ("isActive");--> statement-breakpoint
CREATE INDEX "user_bonus_userId_idx" ON "user_bonus" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "user_bonus_bonusId_idx" ON "user_bonus" USING btree ("bonusId");--> statement-breakpoint
CREATE INDEX "chat_msg_roomId_createdAt_idx" ON "ChatMessage" USING btree ("roomId","createdAt");--> statement-breakpoint
CREATE INDEX "chat_msg_createdAt_idx" ON "ChatMessage" USING btree ("createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_room_slug_key" ON "ChatRoom" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "banner_placement_isActive_idx" ON "banner" USING btree ("placement","isActive");--> statement-breakpoint
CREATE UNIQUE INDEX "user_limit_userId_type_period_key" ON "user_limit" USING btree ("userId","type","period");--> statement-breakpoint
CREATE INDEX "user_limit_userId_idx" ON "user_limit" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "game_round_userId_idx" ON "GameRound" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "admin_invitation_token_idx" ON "admin_invitation" USING btree ("token");--> statement-breakpoint
CREATE INDEX "admin_role_assignment_userId_idx" ON "admin_role_assignment" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "admin_role_permission_roleId_idx" ON "admin_role_permission" USING btree ("roleId");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "twoFactor_userId_idx" ON "twoFactor" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "twoFactor_secret_idx" ON "twoFactor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "lobby_cat_slug_key" ON "LobbyCategory" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "lobby_cat_game_categoryId_idx" ON "LobbyCategoryGame" USING btree ("categoryId");--> statement-breakpoint
CREATE INDEX "notification_userId_idx" ON "notification" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "player_status_idx" ON "player" USING btree ("status");--> statement-breakpoint
CREATE INDEX "player_createdAt_idx" ON "player" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "wallet_transaction_walletId_idx" ON "wallet_transaction" USING btree ("walletId");
