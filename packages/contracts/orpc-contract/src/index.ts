import { populateContractRouterPaths } from '@orpc/contract';
import { healthContract } from './health.js';
import { identityContract } from './identity.js';
import { localizationContract } from './localization.js';
import { cmsContract } from './cms.js';
import { complianceContract } from './compliance.js';
import { notificationsContract } from './notifications.js';
import { walletContract } from './wallet.js';
import { gamingContract } from './gaming.js';
import { bonusContract } from './bonus.js';
import { chatContract } from './chat.js';
import { lobbyContract } from './lobby.js';
import { backofficeContract } from './backoffice.js';
import { profileContract } from './profile.js';

import { iamContract } from './iam.js';

import { auditContract } from './audit.js';

export { healthContract } from './health.js';
export { identityContract } from './identity.js';
export { localizationContract } from './localization.js';
export { cmsContract, PageSchema, BannerSchema } from './cms.js';
export { complianceContract, LimitSchema, GeoRuleSchema } from './compliance.js';
export { notificationsContract, NotificationSchema } from './notifications.js';
export { walletContract, WalletBalanceSchema, WalletTransactionSchema } from './wallet.js';
export { gamingContract, GameSchema, GameRoundSchema } from './gaming.js';
export { bonusContract, BonusSchema, UserBonusSchema } from './bonus.js';
export { chatContract, ChatRoomSchema, ChatMessageSchema } from './chat.js';
export {
  lobbyContract,
  GameSummarySchema,
  LobbyCategorySchema,
  LobbyCategoryDetailSchema,
  FeaturedSlotSchema,
} from './lobby.js';
export {
  backofficeContract,
  PlatformStatsSchema,
  AdminUserSchema,
  AdminTransactionSchema,
} from './backoffice.js';
// Shared player shape (used by the core profile surface and the add-on PAM
// package). The admin PAM route contract + stats schemas moved to
// @oss-addons/player-management. See ADR-0020.
export { PlayerSchema, PlayerStatusSchema, KycStatusSchema } from './player.js';
export {
  profileContract,
  UpdatePlayerProfileInputSchema,
  type UpdatePlayerProfileInput,
} from './profile.js';

export {
  iamContract,
  AdminRoleSchema,
  AdminRolePermissionSchema,
  AdminRoleWithGrantsSchema,
  AdminRoleAssignmentSchema,
  AdminInvitationSchema,
  CatalogEntrySchema,
  GrantInputSchema,
} from './iam.js';

export {
  auditContract,
  AuditLogEntrySchema,
  AuditActorTypeSchema,
  AuditListFiltersSchema,
  AuditExportFiltersSchema,
} from './audit.js';

export const contract = populateContractRouterPaths({
  health: healthContract,
  identity: identityContract,
  localization: localizationContract,
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
