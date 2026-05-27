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
import { playerContract } from './player.js';
import { igamingAggregatorContract } from './igaming-aggregator.js';

import { leaderboardContract } from './leaderboard.js';

import { sportsbookContract } from './sportsbook.js';

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
export {
  playerContract,
  PlayerSchema,
  PlayerStatusSchema,
  KycStatusSchema,
  PlayerRegistrationPointSchema,
  PlayerSummarySchema,
} from './player.js';
export { igamingAggregatorContract } from './igaming-aggregator.js';

export {
  leaderboardContract,
  LeaderboardMetricSchema,
  LeaderboardPeriodSchema,
  LeaderboardEntrySchema,
  LeaderboardResponseSchema,
} from './leaderboard.js';

export {
  sportsbookContract,
  SportsbookEventSchema,
  SportsbookSelectionSchema,
  SportsbookBetSchema,
  OddsUpdateSchema,
  PlaceBetInputSchema,
  PlaceBetResultSchema,
} from './sportsbook.js';

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
  player: playerContract,
  igamingAggregator: igamingAggregatorContract,
  leaderboard: leaderboardContract,
  sportsbook: sportsbookContract,
});

export type Contract = typeof contract;
