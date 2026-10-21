/**
 * Wallet command port: another module moves money on the caller's own `tx`, so the move is
 * atomic with the caller's writes yet the modules stay decoupled and independently extractable. ADR-0017.
 */
import type { WalletTransactionType } from '../schemas/wallet-tx.js';
import { createToken, type Token } from './token.js';
import type { WagerContext } from './wager-context.js';
import type { BonusGrantTerms } from './bonus-grants.js';
import type { WagerTrackingWalletCredit } from './wager-tracking.js';

export type WalletProviderRef = {
  providerName: string;
  providerRefId: string;
  /** RG spend nets a round's legs by this id; a leg without one never offsets a stake. */
  externalRoundId?: string;
  responseSnapshot?: unknown;
};

export type WalletDebitArgs = {
  userId: string;
  amount: string;
  type: WalletTransactionType;
  /** Which of the player's balances to take from. Omit it and the debit falls on the player's active currency (`wallet.currency`). */
  currency?: string;
  providerRef?: WalletProviderRef;
  /**
   * What the bet was placed on, when this debit is one. The bonus engine resolves a wagering
   * weight from it and gamification counts qualifying wagers off it, so a provider seam that
   * drops it silently stops both. Absent for a debit that is not a bet (a withdrawal, a swap).
   */
  context?: WagerContext;
};

/**
 * `moved: true` means this call changed the balance and wrote the `wallet_transaction` row
 * `transactionId` names; the caller emits `wallet.balance.changed` with it once its own
 * transaction commits, since this port never emits it itself (see WalletCommandsService).
 * `moved: false` is a success that moved nothing: the informational `loss` row or a
 * replayed `providerRef`.
 */
export type WalletDebitOutcome =
  | {
      ok: true;
      moved: true;
      transactionId: string;
      /** Real balance after the debit. Bonus funds are not part of it - they live on the grant. */
      newBalance: string;
      currency: string;
      /** Part of the stake paid out of bonus funds, as a decimal string. Absent when none was. */
      bonusSpent?: string;
      /** Bonus funds left on the grant the bet was attributed to; `'0'` when it was attributed to none, even while a grant is held. */
      bonusBalance?: string;
      /** The grant this debit pushed over its requirement, and what it released into the real balance. */
      completed?: { grantId: string; convertedAmount: string };
      /**
       * Whatever `WAGER_TRACKING` credited to the real balance alongside this bet (rank rakeback),
       * inside the same transaction. Empty when nothing was. The caller emits `wallet.balance.
       * changed` for each once its own transaction commits, the same rule it follows for the bet
       * debit itself - this port never emits it.
       */
      wagerTrackingCredits?: WagerTrackingWalletCredit[];
    }
  | { ok: true; moved: false; newBalance: string; currency: string }
  /** `available` is the real balance plus whatever bonus funds could have covered the rest. */
  | { ok: false; available: string };

export type WalletCreditArgs = {
  userId: string;
  amount: string;
  currency: string;
  type: WalletTransactionType;
  /** Allow crediting a currency the player does not hold a balance in yet, creating the `wallet_balance` row. Off by default. */
  allowNewCurrency?: boolean;
  /** Allow crediting a player who has no `wallet` row at all yet, creating it in the caller's transaction. Off by default. */
  allowNewWallet?: boolean;
  providerRef?: WalletProviderRef;
  /**
   * Terms a `gift`/`rain` credit's underlying bonus grant is created under. Ignored by any other
   * credit type. Omit it and the grant falls back to the bonus module's own default terms, same
   * as before this field existed.
   */
  terms?: BonusGrantTerms;
};

/** `moved` as on `WalletDebitOutcome`; `moved: false` is a replayed `providerRef`. */
export type WalletCreditOutcome =
  | { ok: true; moved: true; transactionId: string; newBalance: string }
  | { ok: true; moved: false; newBalance: string }
  | { ok: false; reason: string };

/** Debit types a correction may take back: a reversed payout, or the stake of a voided bet a reopen puts back in play. */
export const WALLET_CORRECTION_DEBIT_TYPES = ['win_reversal', 'bet'] as const;
export type WalletCorrectionDebitType = (typeof WALLET_CORRECTION_DEBIT_TYPES)[number];

/**
 * Thrown by `correctionDebit` for a type outside `WALLET_CORRECTION_DEBIT_TYPES`, and by `debit` and
 * `credit` for `win_reversal`, which only a correction, with its round, may write.
 */
export class WalletCorrectionTypeError extends Error {
  readonly type: string;

  constructor(type: string) {
    super(`a ${type} debit is not allowed here`);
    this.name = 'WalletCorrectionTypeError';
    this.type = type;
  }
}

/**
 * Thrown by `correctionDebit` when its `providerRef` is already on a ledger move it did not write,
 * or a replay does not match the first call. Nothing it collected is kept, even if the caller
 * catches it and commits.
 */
export class WalletCorrectionRefConflictError extends Error {
  readonly providerName: string;
  readonly providerRefId: string;

  constructor(providerName: string, providerRefId: string) {
    super(
      `correction debit reference ${providerName}/${providerRefId} conflicts with an existing ledger move`,
    );
    this.name = 'WalletCorrectionRefConflictError';
    this.providerName = providerName;
    this.providerRefId = providerRefId;
  }
}

/** Thrown by `correctionDebit` when its `providerRef` names no round, which RG spend could not net. */
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

/**
 * Thrown by `correctionDebit` asking more than its round has left to take back: the round's `win`
 * credits less its `win_reversal` debits, or its `bet_reversal` credits less its correction `bet`
 * debits, counting what was collected. Nothing is collected.
 */
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

/** Thrown by `placeWithdrawalHold` for a player with no wallet row, which has nothing to hold. */
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
  /**
   * Required, with its round: a retry with the same reference collects once. One already on another
   * ledger move, or a replay asking a different amount than the first call, is refused.
   */
  providerRef: WalletProviderRef & { externalRoundId: string };
};

/**
 * Collects min(real balance, amount); `shortfall` is the rest, which the caller records as debt.
 * `moved: false` means nothing was collected now: a zero balance, or a replayed `providerRef`, which
 * returns what the first call collected. Every call writes its ledger row, a zero one included, so
 * a retry replays it instead of collecting again.
 */
export type WalletCorrectionDebitOutcome =
  | {
      moved: true;
      transactionId: string;
      collected: string;
      shortfall: string;
      newBalance: string;
    }
  | { moved: false; collected: string; shortfall: string; newBalance: string };

export type WalletWithdrawalHoldArgs = {
  userId: string;
  /** The owning module's key. A source releases only its own hold. */
  source: string;
  reason: string;
};

export type WalletCommands = {
  debit(tx: unknown, args: WalletDebitArgs): Promise<WalletDebitOutcome>;
  credit(tx: unknown, args: WalletCreditArgs): Promise<WalletCreditOutcome>;
  /**
   * A correction is never refused for a short balance, and skips play eligibility, RG limits and
   * the bonus engine: it takes back money already paid, it is not a wager. It is refused with
   * `WalletCorrectionExceedsRoundError` for more than its round paid, a player with no wallet included.
   */
  correctionDebit(
    tx: unknown,
    args: WalletCorrectionDebitArgs,
  ): Promise<WalletCorrectionDebitOutcome>;
  /**
   * Blocks every withdrawal until released. Placing an existing hold updates its reason. A hold
   * placed, re-reasoned or released writes its audit row in `tx`. Throws
   * `WalletHoldWithoutWalletError` for a player with no wallet.
   */
  placeWithdrawalHold(tx: unknown, args: WalletWithdrawalHoldArgs): Promise<{ placed: boolean }>;
  releaseWithdrawalHold(
    tx: unknown,
    args: Omit<WalletWithdrawalHoldArgs, 'reason'>,
  ): Promise<{ released: boolean }>;
};

export const WALLET_COMMANDS: Token<WalletCommands> = createToken('WALLET_COMMANDS');
