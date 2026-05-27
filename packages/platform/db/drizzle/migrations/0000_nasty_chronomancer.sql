CREATE TYPE "public"."BonusType" AS ENUM('welcome', 'deposit_match', 'free_spins', 'custom');--> statement-breakpoint
CREATE TYPE "public"."UserBonusStatus" AS ENUM('pending', 'active', 'completed', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."GameRoundStatus" AS ENUM('active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."LeaderboardMetric" AS ENUM('wagers', 'wins');--> statement-breakpoint
CREATE TYPE "public"."LeaderboardPeriod" AS ENUM('daily', 'weekly');--> statement-breakpoint
CREATE TYPE "public"."WalletTransactionStatus" AS ENUM('pending', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."WalletTransactionType" AS ENUM('deposit', 'withdrawal', 'bet', 'win');--> statement-breakpoint
CREATE TABLE "geo_rule" (
	"id" text PRIMARY KEY NOT NULL,
	"countryCode" text NOT NULL,
	"action" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "geo_rule_countryCode_unique" UNIQUE("countryCode")
);
--> statement-breakpoint
CREATE TABLE "user_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"type" text NOT NULL,
	"amount" real NOT NULL,
	"period" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
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
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"token" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'player' NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locale" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"isDefault" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "locale_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "translation" (
	"id" text PRIMARY KEY NOT NULL,
	"localeId" text NOT NULL,
	"namespace" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"readAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aggregator_provider" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"config" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bonus" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
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
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"userId" text NOT NULL,
	"bonusId" text NOT NULL,
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
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"roomId" text,
	"userId" text NOT NULL,
	"username" text NOT NULL,
	"content" text NOT NULL,
	"isDeleted" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChatRoom" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"isPublic" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Game" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
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
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"gameId" text NOT NULL,
	"userId" text NOT NULL,
	"status" "GameRoundStatus" DEFAULT 'active' NOT NULL,
	"betAmount" numeric DEFAULT '0' NOT NULL,
	"winAmount" numeric DEFAULT '0' NOT NULL,
	"currency" text NOT NULL,
	"startedAt" timestamp DEFAULT now() NOT NULL,
	"endedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "leaderboard" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"metric" "LeaderboardMetric" NOT NULL,
	"period" "LeaderboardPeriod" NOT NULL,
	"periodStart" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leaderboard_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"leaderboardId" text NOT NULL,
	"userId" text NOT NULL,
	"score" numeric DEFAULT '0' NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "FeaturedSlot" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"gameId" text NOT NULL,
	"title" text NOT NULL,
	"placement" text NOT NULL,
	"sortOrder" integer DEFAULT 0 NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "LobbyCategory" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"sortOrder" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "LobbyCategoryGame" (
	"id" text PRIMARY KEY NOT NULL,
	"categoryId" text NOT NULL,
	"gameId" text NOT NULL,
	"sortOrder" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"tenantId" text NOT NULL,
	"balance" numeric DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "wallet_userId_unique" UNIQUE("userId")
);
--> statement-breakpoint
CREATE TABLE "wallet_transaction" (
	"id" text PRIMARY KEY NOT NULL,
	"walletId" text NOT NULL,
	"tenantId" text NOT NULL,
	"type" "WalletTransactionType" NOT NULL,
	"amount" numeric NOT NULL,
	"currency" text NOT NULL,
	"status" "WalletTransactionStatus" DEFAULT 'pending' NOT NULL,
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "banner" (
	"id" text PRIMARY KEY NOT NULL,
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
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"publishedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "page_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "player" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
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
	"tenantId" text DEFAULT 'default' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "player_userId_unique" UNIQUE("userId")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation" ADD CONSTRAINT "translation_localeId_locale_id_fk" FOREIGN KEY ("localeId") REFERENCES "public"."locale"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_bonus" ADD CONSTRAINT "user_bonus_bonusId_bonus_id_fk" FOREIGN KEY ("bonusId") REFERENCES "public"."bonus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_roomId_ChatRoom_id_fk" FOREIGN KEY ("roomId") REFERENCES "public"."ChatRoom"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "GameRound" ADD CONSTRAINT "GameRound_gameId_Game_id_fk" FOREIGN KEY ("gameId") REFERENCES "public"."Game"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaderboard_entry" ADD CONSTRAINT "leaderboard_entry_leaderboardId_leaderboard_id_fk" FOREIGN KEY ("leaderboardId") REFERENCES "public"."leaderboard"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "LobbyCategoryGame" ADD CONSTRAINT "LobbyCategoryGame_categoryId_LobbyCategory_id_fk" FOREIGN KEY ("categoryId") REFERENCES "public"."LobbyCategory"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transaction" ADD CONSTRAINT "wallet_transaction_walletId_wallet_id_fk" FOREIGN KEY ("walletId") REFERENCES "public"."wallet"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_limit_userId_type_period_key" ON "user_limit" USING btree ("userId","type","period");--> statement-breakpoint
CREATE INDEX "user_limit_userId_idx" ON "user_limit" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "translation_localeId_namespace_key_key" ON "translation" USING btree ("localeId","namespace","key");--> statement-breakpoint
CREATE INDEX "notification_userId_idx" ON "notification" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "aggregator_provider_tenantId_slug_key" ON "aggregator_provider" USING btree ("tenantId","slug");--> statement-breakpoint
CREATE INDEX "bonus_tenantId_isActive_idx" ON "bonus" USING btree ("tenantId","isActive");--> statement-breakpoint
CREATE INDEX "user_bonus_tenantId_userId_idx" ON "user_bonus" USING btree ("tenantId","userId");--> statement-breakpoint
CREATE INDEX "user_bonus_bonusId_idx" ON "user_bonus" USING btree ("bonusId");--> statement-breakpoint
CREATE INDEX "chat_msg_roomId_createdAt_idx" ON "ChatMessage" USING btree ("roomId","createdAt");--> statement-breakpoint
CREATE INDEX "chat_msg_tenantId_createdAt_idx" ON "ChatMessage" USING btree ("tenantId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_room_tenantId_slug_key" ON "ChatRoom" USING btree ("tenantId","slug");--> statement-breakpoint
CREATE INDEX "game_tenantId_idx" ON "Game" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "game_round_tenantId_idx" ON "GameRound" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "game_round_userId_idx" ON "GameRound" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "leaderboard_tenantId_idx" ON "leaderboard" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "leaderboard_tenant_metric_period_idx" ON "leaderboard" USING btree ("tenantId","metric","period");--> statement-breakpoint
CREATE INDEX "leaderboard_entry_leaderboardId_idx" ON "leaderboard_entry" USING btree ("leaderboardId");--> statement-breakpoint
CREATE UNIQUE INDEX "leaderboard_entry_lb_user_idx" ON "leaderboard_entry" USING btree ("leaderboardId","userId");--> statement-breakpoint
CREATE INDEX "featured_slot_tenantId_idx" ON "FeaturedSlot" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "lobby_cat_tenantId_slug_key" ON "LobbyCategory" USING btree ("tenantId","slug");--> statement-breakpoint
CREATE INDEX "lobby_cat_tenantId_idx" ON "LobbyCategory" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "lobby_cat_game_categoryId_idx" ON "LobbyCategoryGame" USING btree ("categoryId");--> statement-breakpoint
CREATE INDEX "wallet_tenantId_idx" ON "wallet" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "wallet_transaction_walletId_idx" ON "wallet_transaction" USING btree ("walletId");--> statement-breakpoint
CREATE INDEX "wallet_transaction_tenantId_idx" ON "wallet_transaction" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "banner_placement_isActive_idx" ON "banner" USING btree ("placement","isActive");--> statement-breakpoint
CREATE INDEX "player_status_idx" ON "player" USING btree ("status");--> statement-breakpoint
CREATE INDEX "player_tenantId_idx" ON "player" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "player_createdAt_idx" ON "player" USING btree ("createdAt");