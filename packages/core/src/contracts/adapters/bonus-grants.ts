import type {
  BonusBetClass,
  BonusExistingBalanceMode,
  BonusFreeFundsOrder,
  BonusGrantBucket,
  BonusGrantSource,
  BonusGrantStatus,
  BonusRolloverBase,
  GrantSlotTakenPolicy,
} from '../schemas/promo.js';
import { createToken, type Token } from './token.js';
import type { WagerProduct } from './wager-context.js';

export type BonusFundSettings = {
  rolloverBase: BonusRolloverBase;
  existingBalance: BonusExistingBalanceMode;
  freeFundsOrder: BonusFreeFundsOrder;
  dustThresholdUsd: string;
  decimals: number;
  lockWithdrawals?: boolean;
  betClassBuckets?: Partial<Record<BonusBetClass, BonusGrantBucket[]>>;
};

export type BonusGrantTerms = {
  wageringMultiplier: string;
  expiryDays: number;
  weightProfileId?: string;
  maxBet?: string | null;
  maxBetRate?: string | null;
  maxBetFloor?: string | null;
  maxBetCeiling?: string | null;
  maxBetExemptProducts?: WagerProduct[];
  maxWinMultiplier?: string | null;
  excludedProducts?: WagerProduct[];
  funds?: BonusFundSettings;
  allowPlayerForfeit?: boolean;
};

export type BonusGrantActor = { type: 'admin'; id: string } | { type: 'system' };

export type BonusGrantArgs = {
  userId: string;
  currency: string;
  amount: string;
  source: BonusGrantSource;
  sourceRef: string;
  actor: BonusGrantActor;
  offerId?: string;
  terms?: BonusGrantTerms;
  onSlotTaken?: GrantSlotTakenPolicy;
  buckets?: { linked: string; unlinked: string };
  wageringRequired?: string;
};

export type BonusGrantOutcome =
  | {
      ok: true;
      grantId: string;
      created: boolean;
      status?: BonusGrantStatus;
    }
  | {
      ok: false;
      reason: 'ineligible' | 'offer_inactive' | 'currency_unsupported' | 'slot_taken';
    };

export type BonusGrantCommands = {
  grant(tx: unknown, args: BonusGrantArgs): Promise<BonusGrantOutcome>;
};

export const BONUS_GRANTS: Token<BonusGrantCommands> = createToken('BONUS_GRANTS');
