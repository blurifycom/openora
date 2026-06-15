import { populateContractRouterPaths } from '@orpc/contract';
import { healthContract } from './health.js';

// Each add-on OWNS its route contract (src/contract/index.ts, exported as
// @oss-addons/<name>/contract) - the single source of truth, co-located with the
// service + router that implement it. This package is the AGGREGATOR: it composes
// the always-loaded core add-on contracts into the one runtime `contract` object
// the SDK's typed client links against, and re-exports their schemas so existing
// `@oss/orpc-contract` imports keep resolving. Gated add-on contracts are NOT
// aggregated here - they merge conditionally in apps/api (editions.ts), so the
// default typed client carries no gated surface. `health` is the only contract
// owned here (it is not an add-on). See ADR-0021.
import { identityContract } from '@oss/pam/contracts/identity';
import { cmsContract } from '@oss/cms/contracts';
import { complianceContract } from '@oss/pam/contracts/compliance';
import { notificationsContract } from '@oss/engagement/contracts/notifications';
import { walletContract } from '@oss/wallet/contract';
import { gamingContract } from '@oss/casino/contracts/gaming';
import { bonusContract } from '@oss/engagement/contracts/bonus';
import { chatContract } from '@oss/engagement/contracts/chat';
import { lobbyContract } from '@oss/casino/contracts/lobby';
import { backofficeContract } from '@oss-addons/admin-console/contract';
import { profileContract } from '@oss/pam/contracts/profile';
import { iamContract } from '@oss-addons/iam/contract';
import { auditContract } from '@oss-addons/audit/contract';

export { healthContract } from './health.js';
export { identityContract } from '@oss/pam/contracts/identity';
export { cmsContract, PageSchema, BannerSchema } from '@oss/cms/contracts';
export { complianceContract, LimitSchema, GeoRuleSchema } from '@oss/pam/contracts/compliance';
export { notificationsContract, NotificationSchema } from '@oss/engagement/contracts/notifications';
export { walletContract, WalletBalanceSchema, WalletTransactionSchema } from '@oss/wallet/contract';
export { gamingContract, GameSchema, GameRoundSchema } from '@oss/casino/contracts/gaming';
export { bonusContract, BonusSchema, UserBonusSchema } from '@oss/engagement/contracts/bonus';
export {
  chatContract,
  ChatRoomSchema,
  ChatMessageSchema,
  ChatConnectionGrantSchema,
} from '@oss/engagement/contracts/chat';
export {
  lobbyContract,
  GameSummarySchema,
  LobbyCategorySchema,
  LobbyCategoryDetailSchema,
  FeaturedSlotSchema,
} from '@oss/casino/contracts/lobby';
export {
  backofficeContract,
  PlatformStatsSchema,
  AdminUserSchema,
  AdminTransactionSchema,
} from '@oss-addons/admin-console/contract';
// Canonical player shape - shared by the profile add-on + the player-management
// add-on, so it lives in shared-schemas; re-exported here for back-compat (the SDK
// imports it from @oss/orpc-contract).
export { PlayerSchema, PlayerStatusSchema, KycStatusSchema } from '@oss/shared-schemas';
export {
  profileContract,
  UpdatePlayerProfileInputSchema,
  type UpdatePlayerProfileInput,
} from '@oss/pam/contracts/profile';
export {
  iamContract,
  AdminRoleSchema,
  AdminRolePermissionSchema,
  AdminRoleWithGrantsSchema,
  AdminRoleAssignmentSchema,
  AdminInvitationSchema,
  CatalogEntrySchema,
  GrantInputSchema,
} from '@oss-addons/iam/contract';
export {
  auditContract,
  AuditLogEntrySchema,
  AuditActorTypeSchema,
  AuditListFiltersSchema,
  AuditExportFiltersSchema,
} from '@oss-addons/audit/contract';

export const contract = populateContractRouterPaths({
  health: healthContract,
  identity: identityContract,
  cms: cmsContract,
  compliance: complianceContract,
  notifications: notificationsContract,
  wallet: walletContract,
  gaming: gamingContract,
  bonus: bonusContract,
  chat: chatContract,
  lobby: lobbyContract,
  backoffice: backofficeContract,
  profile: profileContract,
  iam: iamContract,
  audit: auditContract,
});

export type Contract = typeof contract;
