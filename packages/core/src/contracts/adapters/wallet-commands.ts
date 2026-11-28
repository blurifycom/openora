import type { WalletTransactionType } from '../schemas/wallet-tx.js';
import { createToken, type Token } from './token.js';
import type { WagerContext } from './wager-context.js';
import type { BonusGrantTerms } from './bonus-grants.js';
import type { BonusCompletion } from './bonus-wagering.js';
import type { WagerTrackingWalletCredit } from './wager-tracking.js';
import type { AddTurnoverRequirementArgs, AddTurnoverRequirementResult } from './turnover.js';

export type WalletProviderRef = {
  providerName: string;
  providerRefId: string;
  externalRoundId?: string;
  responseSnapshot?: unknown;
};

export type WalletDebitArgs = {
  userId: string;
  amount: string;
  type: WalletTransactionType;
  currency?: string;
  providerRef?: WalletProviderRef;
  context?: WagerContext;
};

export type WalletDebitOutcome =
  | {
      ok: true;
      moved: true;
      transactionId: string;
      newBalance: string;
      currency: string;
      bonusSpent?: string;
      bonusBalance?: string;
      wagerTrackingCredits?: WagerTrackingWalletCredit[];
    }
  | {
      ok: true;
      moved: false;
      newBalance: string;
      currency: string;
      replayedTransactionId?: string;
      completed?: BonusCompletion[];
    }
  | { ok: false; available: string };

export type WalletCreditArgs = {
  userId: string;
  amount: string;
  currency: string;
  type: WalletTransactionType;
  allowNewCurrency?: boolean;
  allowNewWallet?: boolean;
  providerRef?: WalletProviderRef;
  terms?: BonusGrantTerms;
  reversesTransactionId?: string;
  closesRound?: boolean;
};

export const WALLET_BET_ALREADY_REVERSED = 'bet already reversed';

export const WALLET_REVERSAL_UNMATCHED = 'bet reversal matches no stake';

export type WalletCreditOutcome =
  | {
      ok: true;
      moved: true;
      transactionId: string;
      newBalance: string;
      completed?: BonusCompletion[];
    }
  | {
      ok: true;
      moved: false;
      newBalance: string;
      replayedTransactionId?: string;
    }
  | { ok: false; reason: string };

export type WalletCloseRoundArgs = {
  userId: string;
  currency: string;
  providerRef: { providerName: string; externalRoundId: string };
};

export const WALLET_CORRECTION_DEBIT_TYPES = ['win_reversal', 'bet'] as const;
export type WalletCorrectionDebitType = (typeof WALLET_CORRECTION_DEBIT_TYPES)[number];

export class WalletCorrectionTypeError extends Error {
  readonly type: string;

  constructor(type: string) {
    super(`a ${type} debit is not allowed here`);
    this.name = 'WalletCorrectionTypeError';
    this.type = type;
  }
}

export class WalletCorrectionRefConflictError extends Error {
  readonly providerName: string;
  readonly providerRefId: string;
  readonly transactionId: string;

  constructor(providerName: string, providerRefId: string, transactionId: string) {
    super(
      `correction debit reference ${providerName}/${providerRefId} conflicts with an existing ledger move`,
    );
    this.name = 'WalletCorrectionRefConflictError';
    this.providerName = providerName;
    this.providerRefId = providerRefId;
    this.transactionId = transactionId;
  }
}

export class WalletCommandAmountError extends Error {
  readonly operation: string;
  readonly amount: string;

  constructor(operation: string, amount: string) {
    super(
      `wallet ${operation} amount must be a positive decimal with at most 18 places (got ${amount})`,
    );
    this.name = 'WalletCommandAmountError';
    this.operation = operation;
    this.amount = amount;
  }
}

export class WalletReplayMismatchError extends Error {
  readonly providerName: string;
  readonly providerRefId: string;
  readonly transactionId: string;

  constructor(providerName: string, providerRefId: string, transactionId: string) {
    super(
      `wallet reference ${providerName}/${providerRefId} was already used by a different request`,
    );
    this.name = 'WalletReplayMismatchError';
    this.providerName = providerName;
    this.providerRefId = providerRefId;
    this.transactionId = transactionId;
  }
}

export class WalletCorrectionRoundError extends Error {
  readonly providerName: string;
  readonly providerRefId: string;

  constructor(providerName: string, providerRefId: string) {
    super(`correction debit reference ${providerName}/${providerRefId} names no round`);
    this.name = 'WalletCorrectionRoundError';
    this.providerName = providerName;
    this.providerRefId = providerRefId;
  }
}

export class WalletCorrectionExceedsRoundError extends Error {
  readonly providerName: string;
  readonly externalRoundId: string;
  readonly type: WalletCorrectionDebitType;
  readonly requested: string;
  readonly available: string;

  constructor(
    providerName: string,
    externalRoundId: string,
    type: WalletCorrectionDebitType,
    requested: string,
    available: string,
  ) {
    super(
      `${type} correction of ${requested} exceeds the ${available} round ${providerName}/${externalRoundId} has left`,
    );
    this.name = 'WalletCorrectionExceedsRoundError';
    this.providerName = providerName;
    this.externalRoundId = externalRoundId;
    this.type = type;
    this.requested = requested;
    this.available = available;
  }
}

export class WalletHoldWithoutWalletError extends Error {
  readonly userId: string;

  constructor(userId: string) {
    super(`player ${userId} has no wallet to hold withdrawals on`);
    this.name = 'WalletHoldWithoutWalletError';
    this.userId = userId;
  }
}

export type WalletCorrectionDebitArgs = {
  userId: string;
  amount: string;
  currency: string;
  type: WalletCorrectionDebitType;
  providerRef: WalletProviderRef & { externalRoundId: string };
};

export type WalletCorrectionDebitOutcome =
  | {
      moved: true;
      transactionId: string;
      collected: string;
      shortfall: string;
      newBalance: string;
    }
  | {
      moved: false;
      collected: string;
      shortfall: string;
      newBalance: string;
      replayedTransactionId?: string;
    };

export type WalletWithdrawalHoldArgs = {
  userId: string;
  source: string;
  reason: string;
};

export const WALLET_LOCK_EXEMPT_DEBIT_TYPES = ['bet', 'loss', 'manual_debit'] as const;

export const WALLET_FUNDS_LOCKS = ['turnover', 'bonus'] as const;

export type MovableFundsArgs = { userId: string; currency: string };
export type MovableFunds = {
  real: string;
  locked: string;
  free: string;
  lockedBy?: (typeof WALLET_FUNDS_LOCKS)[number];
};

export type WalletCommands = {
  debit(tx: unknown, args: WalletDebitArgs): Promise<WalletDebitOutcome>;
  movableFunds?(tx: unknown, args: MovableFundsArgs): Promise<MovableFunds>;
  credit(tx: unknown, args: WalletCreditArgs): Promise<WalletCreditOutcome>;
  correctionDebit(
    tx: unknown,
    args: WalletCorrectionDebitArgs,
  ): Promise<WalletCorrectionDebitOutcome>;
  placeWithdrawalHold(tx: unknown, args: WalletWithdrawalHoldArgs): Promise<{ placed: boolean }>;
  releaseWithdrawalHold(
    tx: unknown,
    args: Omit<WalletWithdrawalHoldArgs, 'reason'>,
  ): Promise<{ released: boolean }>;
  closeRound?(
    tx: unknown,
    args: WalletCloseRoundArgs,
  ): Promise<{ completed: BonusCompletion[]; newBalance: string | null }>;
  addTurnoverRequirement?(
    tx: unknown,
    args: AddTurnoverRequirementArgs,
  ): Promise<AddTurnoverRequirementResult>;
  lockWallets?(tx: unknown, args: { userIds: readonly string[] }): Promise<void>;
};

export const WALLET_COMMANDS: Token<WalletCommands> = createToken('WALLET_COMMANDS');
