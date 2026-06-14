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
import { identityContract } from '@oss-addons/identity/contract';
import { cmsContract } from '@oss-addons/cms/contract';
import { complianceContract } from '@oss-addons/compliance/contract';
import { notificationsContract } from '@oss-addons/notifications/contract';
import { walletContract } from '@oss-addons/wallet/contract';
import { gamingContract } from '@oss-addons/gaming/contract';
import { bonusContract } from '@oss-addons/bonus/contract';
import { chatContract } from '@oss-addons/chat/contract';
import { lobbyContract } from '@oss-addons/lobby/contract';
import { backofficeContract } from '@oss-addons/admin-console/contract';
import { profileContract } from '@oss-addons/profile/contract';
import { iamContract } from '@oss-addons/iam/contract';
import { auditContract } from '@oss-addons/audit/contract';

export { healthContract } from './health.js';
export { identityContract } from '@oss-addons/identity/contract';
export { cmsContract, PageSchema, BannerSchema } from '@oss-addons/cms/contract';
export { complianceContract, LimitSchema, GeoRuleSchema } from '@oss-addons/compliance/contract';
export { notificationsContract, NotificationSchema } from '@oss-addons/notifications/contract';
export {
  walletContract,
  WalletBalanceSchema,
  WalletTransactionSchema,
} from '@oss-addons/wallet/contract';
export { gamingContract, GameSchema, GameRoundSchema } from '@oss-addons/gaming/contract';
export { bonusContract, BonusSchema, UserBonusSchema } from '@oss-addons/bonus/contract';
export {
  chatContract,
  ChatRoomSchema,
  ChatMessageSchema,
  ChatConnectionGrantSchema,
} from '@oss-addons/chat/contract';
export {
  lobbyContract,
  GameSummarySchema,
  LobbyCategorySchema,
  LobbyCategoryDetailSchema,
  FeaturedSlotSchema,
} from '@oss-addons/lobby/contract';
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
} from '@oss-addons/profile/contract';
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
