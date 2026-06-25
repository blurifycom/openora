ALTER TYPE "public"."BonusType" RENAME TO "bonus_type";
--> statement-breakpoint
ALTER TYPE "public"."UserBonusStatus" RENAME TO "user_bonus_status";
--> statement-breakpoint
ALTER TYPE "public"."GameRoundStatus" RENAME TO "game_round_status";
--> statement-breakpoint
ALTER TYPE "public"."WalletTransactionStatus" RENAME TO "wallet_transaction_status";
--> statement-breakpoint
ALTER TYPE "public"."WalletTransactionType" RENAME TO "wallet_transaction_type";
--> statement-breakpoint
ALTER TABLE "public"."event_outbox" RENAME COLUMN "eventId" TO "event_id";
--> statement-breakpoint
ALTER TABLE "public"."event_outbox" RENAME COLUMN "schemaVersion" TO "schema_version";
--> statement-breakpoint
ALTER TABLE "public"."event_outbox" RENAME COLUMN "traceId" TO "trace_id";
--> statement-breakpoint
ALTER TABLE "public"."event_outbox" RENAME COLUMN "orderingKey" TO "ordering_key";
--> statement-breakpoint
ALTER TABLE "public"."event_outbox" RENAME COLUMN "occurredAt" TO "occurred_at";
--> statement-breakpoint
ALTER TABLE "public"."event_outbox" RENAME COLUMN "publishedAt" TO "published_at";
--> statement-breakpoint
ALTER TABLE "public"."event_outbox" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER TABLE "public"."audit_log" RENAME COLUMN "actorId" TO "actor_id";
--> statement-breakpoint
ALTER TABLE "public"."audit_log" RENAME COLUMN "actorType" TO "actor_type";
--> statement-breakpoint
ALTER TABLE "public"."audit_log" RENAME COLUMN "resourceType" TO "resource_type";
--> statement-breakpoint
ALTER TABLE "public"."audit_log" RENAME COLUMN "resourceId" TO "resource_id";
--> statement-breakpoint
ALTER TABLE "public"."audit_log" RENAME COLUMN "userAgent" TO "user_agent";
--> statement-breakpoint
ALTER TABLE "public"."audit_log" RENAME COLUMN "correlationId" TO "correlation_id";
--> statement-breakpoint
ALTER TABLE "public"."audit_log" RENAME COLUMN "prevHash" TO "prev_hash";
--> statement-breakpoint
ALTER TABLE "public"."audit_log" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER INDEX "public"."audit_log_actorId_idx" RENAME TO "audit_log_actor_id_idx";
--> statement-breakpoint
ALTER INDEX "public"."audit_log_resourceType_idx" RENAME TO "audit_log_resource_type_idx";
--> statement-breakpoint
ALTER INDEX "public"."audit_log_createdAt_idx" RENAME TO "audit_log_created_at_idx";
--> statement-breakpoint
ALTER TABLE "public"."bonus" RENAME COLUMN "minDeposit" TO "min_deposit";
--> statement-breakpoint
ALTER TABLE "public"."bonus" RENAME COLUMN "wagerMultiplier" TO "wager_multiplier";
--> statement-breakpoint
ALTER TABLE "public"."bonus" RENAME COLUMN "isActive" TO "is_active";
--> statement-breakpoint
ALTER TABLE "public"."bonus" RENAME COLUMN "expiresAt" TO "expires_at";
--> statement-breakpoint
ALTER TABLE "public"."bonus" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER TABLE "public"."bonus" RENAME COLUMN "updatedAt" TO "updated_at";
--> statement-breakpoint
ALTER INDEX "public"."bonus_isActive_idx" RENAME TO "bonus_is_active_idx";
--> statement-breakpoint
ALTER TABLE "public"."user_bonus" RENAME COLUMN "userId" TO "user_id";
--> statement-breakpoint
ALTER TABLE "public"."user_bonus" RENAME COLUMN "bonusId" TO "bonus_id";
--> statement-breakpoint
ALTER TABLE "public"."user_bonus" RENAME COLUMN "awardedAmount" TO "awarded_amount";
--> statement-breakpoint
ALTER TABLE "public"."user_bonus" RENAME COLUMN "wageredAmount" TO "wagered_amount";
--> statement-breakpoint
ALTER TABLE "public"."user_bonus" RENAME COLUMN "wagerRequirement" TO "wager_requirement";
--> statement-breakpoint
ALTER TABLE "public"."user_bonus" RENAME COLUMN "expiresAt" TO "expires_at";
--> statement-breakpoint
ALTER TABLE "public"."user_bonus" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER TABLE "public"."user_bonus" RENAME COLUMN "updatedAt" TO "updated_at";
--> statement-breakpoint
ALTER TABLE "public"."user_bonus" RENAME CONSTRAINT "user_bonus_bonusId_bonus_id_fk" TO "user_bonus_bonus_id_bonus_id_fk";
--> statement-breakpoint
ALTER INDEX "public"."user_bonus_userId_idx" RENAME TO "user_bonus_user_id_idx";
--> statement-breakpoint
ALTER INDEX "public"."user_bonus_bonusId_idx" RENAME TO "user_bonus_bonus_id_idx";
--> statement-breakpoint
ALTER TABLE "public"."ChatMessage" RENAME TO "chat_message";
--> statement-breakpoint
ALTER TABLE "public"."chat_message" RENAME COLUMN "roomId" TO "room_id";
--> statement-breakpoint
ALTER TABLE "public"."chat_message" RENAME COLUMN "userId" TO "user_id";
--> statement-breakpoint
ALTER TABLE "public"."chat_message" RENAME COLUMN "isDeleted" TO "is_deleted";
--> statement-breakpoint
ALTER TABLE "public"."chat_message" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER TABLE "public"."chat_message" RENAME CONSTRAINT "ChatMessage_roomId_ChatRoom_id_fk" TO "chat_message_room_id_chat_room_id_fk";
--> statement-breakpoint
ALTER INDEX "public"."chat_msg_roomId_createdAt_idx" RENAME TO "chat_msg_room_id_created_at_idx";
--> statement-breakpoint
ALTER INDEX "public"."chat_msg_createdAt_idx" RENAME TO "chat_msg_created_at_idx";
--> statement-breakpoint
ALTER TABLE "public"."ChatRoom" RENAME TO "chat_room";
--> statement-breakpoint
ALTER TABLE "public"."chat_room" RENAME COLUMN "isPublic" TO "is_public";
--> statement-breakpoint
ALTER TABLE "public"."chat_room" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER TABLE "public"."ChatUserBlock" RENAME TO "chat_user_block";
--> statement-breakpoint
ALTER TABLE "public"."chat_user_block" RENAME COLUMN "blockerId" TO "blocker_id";
--> statement-breakpoint
ALTER TABLE "public"."chat_user_block" RENAME COLUMN "blockedId" TO "blocked_id";
--> statement-breakpoint
ALTER TABLE "public"."chat_user_block" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER TABLE "public"."banner" RENAME COLUMN "imageUrl" TO "image_url";
--> statement-breakpoint
ALTER TABLE "public"."banner" RENAME COLUMN "linkUrl" TO "link_url";
--> statement-breakpoint
ALTER TABLE "public"."banner" RENAME COLUMN "isActive" TO "is_active";
--> statement-breakpoint
ALTER TABLE "public"."banner" RENAME COLUMN "sortOrder" TO "sort_order";
--> statement-breakpoint
ALTER TABLE "public"."banner" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER TABLE "public"."banner" RENAME COLUMN "updatedAt" TO "updated_at";
--> statement-breakpoint
ALTER INDEX "public"."banner_placement_isActive_idx" RENAME TO "banner_placement_is_active_idx";
--> statement-breakpoint
ALTER TABLE "public"."page" RENAME COLUMN "publishedAt" TO "published_at";
--> statement-breakpoint
ALTER TABLE "public"."page" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER TABLE "public"."page" RENAME COLUMN "updatedAt" TO "updated_at";
--> statement-breakpoint
ALTER TABLE "public"."geo_rule" RENAME COLUMN "countryCode" TO "country_code";
--> statement-breakpoint
ALTER TABLE "public"."geo_rule" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER TABLE "public"."geo_rule" RENAME CONSTRAINT "geo_rule_countryCode_unique" TO "geo_rule_country_code_unique";
--> statement-breakpoint
ALTER TABLE "public"."user_limit" RENAME COLUMN "userId" TO "user_id";
--> statement-breakpoint
ALTER TABLE "public"."user_limit" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER TABLE "public"."user_limit" RENAME COLUMN "updatedAt" TO "updated_at";
--> statement-breakpoint
ALTER INDEX "public"."user_limit_userId_type_period_key" RENAME TO "user_limit_user_id_type_period_key";
--> statement-breakpoint
ALTER INDEX "public"."user_limit_userId_idx" RENAME TO "user_limit_user_id_idx";
--> statement-breakpoint
ALTER TABLE "public"."Game" RENAME TO "game";
--> statement-breakpoint
ALTER TABLE "public"."game" RENAME COLUMN "thumbnailUrl" TO "thumbnail_url";
--> statement-breakpoint
ALTER TABLE "public"."game" RENAME COLUMN "isActive" TO "is_active";
--> statement-breakpoint
ALTER TABLE "public"."game" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER TABLE "public"."GameRound" RENAME TO "game_round";
--> statement-breakpoint
ALTER TABLE "public"."game_round" RENAME COLUMN "gameId" TO "game_id";
--> statement-breakpoint
ALTER TABLE "public"."game_round" RENAME COLUMN "userId" TO "user_id";
--> statement-breakpoint
ALTER TABLE "public"."game_round" RENAME COLUMN "betAmount" TO "bet_amount";
--> statement-breakpoint
ALTER TABLE "public"."game_round" RENAME COLUMN "winAmount" TO "win_amount";
--> statement-breakpoint
ALTER TABLE "public"."game_round" RENAME COLUMN "startedAt" TO "started_at";
--> statement-breakpoint
ALTER TABLE "public"."game_round" RENAME COLUMN "endedAt" TO "ended_at";
--> statement-breakpoint
ALTER TABLE "public"."game_round" RENAME CONSTRAINT "GameRound_gameId_Game_id_fk" TO "game_round_game_id_game_id_fk";
--> statement-breakpoint
ALTER INDEX "public"."game_round_userId_idx" RENAME TO "game_round_user_id_idx";
--> statement-breakpoint
ALTER TABLE "public"."admin_invitation" RENAME COLUMN "roleId" TO "role_id";
--> statement-breakpoint
ALTER TABLE "public"."admin_invitation" RENAME COLUMN "expiresAt" TO "expires_at";
--> statement-breakpoint
ALTER TABLE "public"."admin_invitation" RENAME COLUMN "acceptedAt" TO "accepted_at";
--> statement-breakpoint
ALTER TABLE "public"."admin_invitation" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER TABLE "public"."admin_invitation" RENAME CONSTRAINT "admin_invitation_roleId_admin_role_id_fk" TO "admin_invitation_role_id_admin_role_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."admin_role" RENAME COLUMN "isSystem" TO "is_system";
--> statement-breakpoint
ALTER TABLE "public"."admin_role" RENAME COLUMN "isSuperAdmin" TO "is_super_admin";
--> statement-breakpoint
ALTER TABLE "public"."admin_role" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER TABLE "public"."admin_role_assignment" RENAME COLUMN "userId" TO "user_id";
--> statement-breakpoint
ALTER TABLE "public"."admin_role_assignment" RENAME COLUMN "roleId" TO "role_id";
--> statement-breakpoint
ALTER TABLE "public"."admin_role_assignment" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER TABLE "public"."admin_role_assignment" RENAME CONSTRAINT "admin_role_assignment_roleId_admin_role_id_fk" TO "admin_role_assignment_role_id_admin_role_id_fk";
--> statement-breakpoint
ALTER INDEX "public"."admin_role_assignment_userId_idx" RENAME TO "admin_role_assignment_user_id_idx";
--> statement-breakpoint
ALTER TABLE "public"."admin_role_permission" RENAME COLUMN "roleId" TO "role_id";
--> statement-breakpoint
ALTER TABLE "public"."admin_role_permission" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER TABLE "public"."admin_role_permission" RENAME COLUMN "updatedAt" TO "updated_at";
--> statement-breakpoint
ALTER TABLE "public"."admin_role_permission" RENAME CONSTRAINT "admin_role_permission_roleId_admin_role_id_fk" TO "admin_role_permission_role_id_admin_role_id_fk";
--> statement-breakpoint
ALTER INDEX "public"."admin_role_permission_roleId_idx" RENAME TO "admin_role_permission_role_id_idx";
--> statement-breakpoint
ALTER TABLE "public"."account" RENAME COLUMN "accountId" TO "account_id";
--> statement-breakpoint
ALTER TABLE "public"."account" RENAME COLUMN "providerId" TO "provider_id";
--> statement-breakpoint
ALTER TABLE "public"."account" RENAME COLUMN "userId" TO "user_id";
--> statement-breakpoint
ALTER TABLE "public"."account" RENAME COLUMN "accessToken" TO "access_token";
--> statement-breakpoint
ALTER TABLE "public"."account" RENAME COLUMN "refreshToken" TO "refresh_token";
--> statement-breakpoint
ALTER TABLE "public"."account" RENAME COLUMN "idToken" TO "id_token";
--> statement-breakpoint
ALTER TABLE "public"."account" RENAME COLUMN "accessTokenExpiresAt" TO "access_token_expires_at";
--> statement-breakpoint
ALTER TABLE "public"."account" RENAME COLUMN "refreshTokenExpiresAt" TO "refresh_token_expires_at";
--> statement-breakpoint
ALTER TABLE "public"."account" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER TABLE "public"."account" RENAME COLUMN "updatedAt" TO "updated_at";
--> statement-breakpoint
ALTER TABLE "public"."account" RENAME CONSTRAINT "account_userId_user_id_fk" TO "account_user_id_user_id_fk";
--> statement-breakpoint
ALTER INDEX "public"."account_userId_idx" RENAME TO "account_user_id_idx";
--> statement-breakpoint
ALTER TABLE "public"."session" RENAME COLUMN "expiresAt" TO "expires_at";
--> statement-breakpoint
ALTER TABLE "public"."session" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER TABLE "public"."session" RENAME COLUMN "updatedAt" TO "updated_at";
--> statement-breakpoint
ALTER TABLE "public"."session" RENAME COLUMN "ipAddress" TO "ip_address";
--> statement-breakpoint
ALTER TABLE "public"."session" RENAME COLUMN "userAgent" TO "user_agent";
--> statement-breakpoint
ALTER TABLE "public"."session" RENAME COLUMN "userId" TO "user_id";
--> statement-breakpoint
ALTER TABLE "public"."session" RENAME CONSTRAINT "session_userId_user_id_fk" TO "session_user_id_user_id_fk";
--> statement-breakpoint
ALTER INDEX "public"."session_userId_idx" RENAME TO "session_user_id_idx";
--> statement-breakpoint
ALTER TABLE "public"."twoFactor" RENAME TO "two_factor";
--> statement-breakpoint
ALTER TABLE "public"."two_factor" RENAME COLUMN "backupCodes" TO "backup_codes";
--> statement-breakpoint
ALTER TABLE "public"."two_factor" RENAME COLUMN "userId" TO "user_id";
--> statement-breakpoint
ALTER TABLE "public"."two_factor" RENAME CONSTRAINT "twoFactor_userId_user_id_fk" TO "two_factor_user_id_user_id_fk";
--> statement-breakpoint
ALTER INDEX "public"."twoFactor_userId_idx" RENAME TO "two_factor_user_id_idx";
--> statement-breakpoint
ALTER INDEX "public"."twoFactor_secret_idx" RENAME TO "two_factor_secret_idx";
--> statement-breakpoint
ALTER TABLE "public"."user" RENAME COLUMN "emailVerified" TO "email_verified";
--> statement-breakpoint
ALTER TABLE "public"."user" RENAME COLUMN "isActive" TO "is_active";
--> statement-breakpoint
ALTER TABLE "public"."user" RENAME COLUMN "banReason" TO "ban_reason";
--> statement-breakpoint
ALTER TABLE "public"."user" RENAME COLUMN "banExpires" TO "ban_expires";
--> statement-breakpoint
ALTER TABLE "public"."user" RENAME COLUMN "twoFactorEnabled" TO "two_factor_enabled";
--> statement-breakpoint
ALTER TABLE "public"."user" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER TABLE "public"."user" RENAME COLUMN "updatedAt" TO "updated_at";
--> statement-breakpoint
ALTER TABLE "public"."verification" RENAME COLUMN "expiresAt" TO "expires_at";
--> statement-breakpoint
ALTER TABLE "public"."verification" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER TABLE "public"."verification" RENAME COLUMN "updatedAt" TO "updated_at";
--> statement-breakpoint
ALTER TABLE "public"."FeaturedSlot" RENAME TO "featured_slot";
--> statement-breakpoint
ALTER TABLE "public"."featured_slot" RENAME COLUMN "gameId" TO "game_id";
--> statement-breakpoint
ALTER TABLE "public"."featured_slot" RENAME COLUMN "sortOrder" TO "sort_order";
--> statement-breakpoint
ALTER TABLE "public"."featured_slot" RENAME COLUMN "isActive" TO "is_active";
--> statement-breakpoint
ALTER TABLE "public"."featured_slot" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER TABLE "public"."LobbyCategory" RENAME TO "lobby_category";
--> statement-breakpoint
ALTER TABLE "public"."lobby_category" RENAME COLUMN "sortOrder" TO "sort_order";
--> statement-breakpoint
ALTER TABLE "public"."lobby_category" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER TABLE "public"."LobbyCategoryGame" RENAME TO "lobby_category_game";
--> statement-breakpoint
ALTER TABLE "public"."lobby_category_game" RENAME COLUMN "categoryId" TO "category_id";
--> statement-breakpoint
ALTER TABLE "public"."lobby_category_game" RENAME COLUMN "gameId" TO "game_id";
--> statement-breakpoint
ALTER TABLE "public"."lobby_category_game" RENAME COLUMN "sortOrder" TO "sort_order";
--> statement-breakpoint
ALTER TABLE "public"."lobby_category_game" RENAME CONSTRAINT "LobbyCategoryGame_categoryId_LobbyCategory_id_fk" TO "lobby_category_game_category_id_lobby_category_id_fk";
--> statement-breakpoint
ALTER INDEX "public"."lobby_cat_game_categoryId_idx" RENAME TO "lobby_cat_game_category_id_idx";
--> statement-breakpoint
ALTER TABLE "public"."notification" RENAME COLUMN "userId" TO "user_id";
--> statement-breakpoint
ALTER TABLE "public"."notification" RENAME COLUMN "readAt" TO "read_at";
--> statement-breakpoint
ALTER TABLE "public"."notification" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER INDEX "public"."notification_userId_idx" RENAME TO "notification_user_id_idx";
--> statement-breakpoint
ALTER TABLE "public"."player" RENAME COLUMN "userId" TO "user_id";
--> statement-breakpoint
ALTER TABLE "public"."player" RENAME COLUMN "displayName" TO "display_name";
--> statement-breakpoint
ALTER TABLE "public"."player" RENAME COLUMN "kycStatus" TO "kyc_status";
--> statement-breakpoint
ALTER TABLE "public"."player" RENAME COLUMN "totalWagered" TO "total_wagered";
--> statement-breakpoint
ALTER TABLE "public"."player" RENAME COLUMN "totalDeposits" TO "total_deposits";
--> statement-breakpoint
ALTER TABLE "public"."player" RENAME COLUMN "lastSeenAt" TO "last_seen_at";
--> statement-breakpoint
ALTER TABLE "public"."player" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER TABLE "public"."player" RENAME COLUMN "updatedAt" TO "updated_at";
--> statement-breakpoint
ALTER TABLE "public"."player" RENAME CONSTRAINT "player_userId_unique" TO "player_user_id_unique";
--> statement-breakpoint
ALTER INDEX "public"."player_createdAt_idx" RENAME TO "player_created_at_idx";
--> statement-breakpoint
ALTER TABLE "public"."wallet" RENAME COLUMN "userId" TO "user_id";
--> statement-breakpoint
ALTER TABLE "public"."wallet" RENAME COLUMN "updatedAt" TO "updated_at";
--> statement-breakpoint
ALTER TABLE "public"."wallet" RENAME CONSTRAINT "wallet_userId_unique" TO "wallet_user_id_unique";
--> statement-breakpoint
ALTER TABLE "public"."wallet_transaction" RENAME COLUMN "walletId" TO "wallet_id";
--> statement-breakpoint
ALTER TABLE "public"."wallet_transaction" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER TABLE "public"."wallet_transaction" RENAME CONSTRAINT "wallet_transaction_walletId_wallet_id_fk" TO "wallet_transaction_wallet_id_wallet_id_fk";
--> statement-breakpoint
ALTER INDEX "public"."wallet_transaction_walletId_idx" RENAME TO "wallet_transaction_wallet_id_idx";
