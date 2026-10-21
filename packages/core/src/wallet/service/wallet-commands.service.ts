import {
  MaxBetExceededError,
  RgLimitExceededError,
  WALLET_CORRECTION_DEBIT_TYPES,
  WalletCorrectionRefConflictError,
  WalletCorrectionRoundError,
  WalletCorrectionTypeError,
  WalletHoldWithoutWalletError,
  type AuditWritePort,
  type PlayEligibilityPort,
  type RgLimitsPort,
  type PlatformConfig,
  type Uuid,
  type WalletCommands,
  type WalletDebitArgs,
  type WalletDebitOutcome,
  type WalletCreditArgs,
  type WalletCreditOutcome,
  type WalletCorrectionDebitArgs,
  type WalletCorrectionDebitOutcome,
  type WalletProviderRef,
  type WalletWithdrawalHoldArgs,
  type WalletTransactionType,
  type BonusGrantCommands,
  type BonusWageringCommands,
} from '@openora/core/contracts';
import {
  createDomainError,
  makeConflictError,
  moneyAdd,
  moneyCompare,
  moneySubtract,
  type DrizzleDb,
} from '@openora/core/server';
import { and, eq } from 'drizzle-orm';
import {
  wallet,
  walletTransaction,
  walletWithdrawalHold,
  type Wallet,
  type WalletTransaction,
} from '../schema/index.js';
import type { ManualAdjustmentDirection } from '../contract/index.js';
import {
  creditWalletBalance,
  balanceKey,
  collectWalletBalance,
  debitWalletBalance,
  providerRefCondition,
  railFor,
  readWalletBalance,
  readWalletBalanceForUpdate,
} from './wallet.service.js';

const WalletCommandAmountError = createDomainError<[operation: string, amount: string]>(
  'WalletCommandAmountError',
  (operation, amount) => `wallet ${operation} amount must be positive (got ${amount})`,
);

// Default in-process WALLET_COMMANDS implementation. Operates on the caller's
// transaction handle, so a move commits or rolls back together with the caller's
// other writes - the same atomicity the cross-module schema-write gave, now behind
// a port the wallet module owns. Every move writes a `wallet_transaction` ledger row
// (status `completed`, internal settlement so no provider ref) so gameplay shows in
// transaction history. The `balance >= amount` guard in the UPDATE makes concurrent
// debits safe (a lost race updates zero rows and we report the shortfall). This service
// does not own the caller's transaction boundary, so it never emits `wallet.balance.changed`
// itself - a move that actually changed the balance instead returns `moved: true` with the
// ledger row's id as `transactionId` on the outcome, and the caller emits the event once
// its own transaction commits (see GamingService.startRound/endRound).
export const WalletRgRestrictedError = makeConflictError(
  'WalletRgRestrictedError',
  'wager is restricted by an active responsible-gambling exclusion',
);

const WalletBonusEngineUnavailableError = createDomainError<[type: string]>(
  'WalletBonusEngineUnavailableError',
  (type) =>
    `a ${type} credit needs the bonus engine to hold its wagering requirement, and none is bound`,
);

const WalletBonusGrantRefusedError = createDomainError<[reason: string]>(
  'WalletBonusGrantRefusedError',
  (reason) => `the bonus engine refused the grant behind this credit: ${reason}`,
);

const WalletBonusSourceRefRequiredError = createDomainError<[type: string]>(
  'WalletBonusSourceRefRequiredError',
  (type) =>
    `a ${type} credit needs a stable providerRef.providerRefId so a retry cannot grant twice`,
);

const WalletCreditFailedError = createDomainError<[walletId: string, currency: string]>(
  'WalletCreditFailedError',
  (walletId, currency) => `wallet ${walletId} has no ${currency} balance row to credit`,
);

const WalletBonusConversionError = createDomainError<[walletId: string, currency: string]>(
  'WalletBonusConversionError',
  (walletId, currency) =>
    `wallet ${walletId} has no ${currency} balance row to convert a completed bonus into`,
);

export type WalletCommandsPorts = {
  platformConfig?: PlatformConfig;
  rgLimits?: RgLimitsPort;
  bonusWagering?: BonusWageringCommands;
  bonusGrants?: BonusGrantCommands;
};

export class WalletCommandsService implements WalletCommands {
  constructor(
    private readonly playEligibility: PlayEligibilityPort,
    private readonly audit: AuditWritePort,
    private readonly ports: WalletCommandsPorts = {},
  ) {}

  // Completed ledger row shared by every gameplay move. `direction` is required (not
  // optional) so a new call site can't compile without deciding it - `debit()` always
  // passes 'debit', `credit()` always passes 'credit', including the gift/rain/tip legs
  // that share one `type` for both sides of the transfer.
  private async writeLedgerRow(
    txn: DrizzleDb,
    row: { id: string; currency: string },
    type: WalletTransactionType,
    amount: string,
    direction: ManualAdjustmentDirection,
    providerRef?: WalletProviderRef,
    { correction = false }: { correction?: boolean } = {},
  ): Promise<{ row: WalletTransaction; replayed: boolean }> {
    const insertQuery = txn.insert(walletTransaction).values({
      walletId: row.id,
      type,
      amount,
      currency: row.currency,
      status: 'completed',
      direction,
      rail: railFor(row.currency, this.ports.platformConfig?.wallet?.cryptoCurrencies),
      providerName: providerRef?.providerName,
      providerRefId: providerRef?.providerRefId,
      externalRoundId: providerRef?.externalRoundId,
      correction,
      metadata:
        providerRef?.responseSnapshot !== undefined
          ? JSON.stringify(providerRef.responseSnapshot)
          : undefined,
    });

    if (!providerRef) {
      const [inserted] = await insertQuery.returning();
      if (!inserted) {
        throw new Error('wallet ledger row: insert returned no row');
      }
      return { row: inserted, replayed: false };
    }

    const [inserted] = await insertQuery.onConflictDoNothing().returning();
    if (inserted) {
      return { row: inserted, replayed: false };
    }

    const existing = await this.findByProviderRef(txn, providerRef);
    if (!existing) {
      throw new Error(
        `wallet ledger row: idempotency conflict but no row found (provider=${providerRef.providerName} ref=${providerRef.providerRefId})`,
      );
    }
    return { row: existing, replayed: true };
  }

  private async findByProviderRef(
    txn: DrizzleDb,
    providerRef: WalletProviderRef,
  ): Promise<WalletTransaction | undefined> {
    const [row] = await txn
      .select()
      .from(walletTransaction)
      .where(providerRefCondition(providerRef.providerName, providerRef.providerRefId));
    return row;
  }

  async debit(
    tx: unknown,
    { userId, amount, type, currency, providerRef, context }: WalletDebitArgs,
  ): Promise<WalletDebitOutcome> {
    const txn = tx as DrizzleDb;

    if (type === 'win_reversal') {
      throw new WalletCorrectionTypeError(type);
    }
    if (type === 'bet' && (await this.playEligibility.isRestricted(userId, txn))) {
      throw new WalletRgRestrictedError();
    }

    // `loss` is informational (stake already left at bet time): 0-amount row, balance untouched. Every other debit is real money.
    if (type !== 'loss' && Number(amount) <= 0) {
      throw new WalletCommandAmountError('debit', amount);
    }

    const [row] = await txn.select().from(wallet).where(eq(wallet.userId, userId)).for('update');
    if (!row) {
      return { ok: false, available: '0' };
    }

    const debitCurrency = balanceKey(currency ?? row.currency);
    const debitRow = { ...row, currency: debitCurrency };

    const available = await readWalletBalanceForUpdate(txn, row.id, debitCurrency);

    if (type === 'loss') {
      await this.writeLedgerRow(txn, debitRow, 'loss', '0', 'debit', providerRef);
      return { ok: true, moved: false, newBalance: available, currency: debitCurrency };
    }

    // Must run before checkWager below - a replay must never re-evaluate the wager limit
    // against spend it already committed.
    if (providerRef && (await this.findByProviderRef(txn, providerRef))) {
      return { ok: true, moved: false, newBalance: available, currency: debitCurrency };
    }

    if (type === 'bet' && this.ports.rgLimits) {
      const decision = await this.ports.rgLimits.checkWager(
        txn,
        userId,
        amount,
        currency ?? row.currency,
      );
      if (!decision.allowed) {
        throw new RgLimitExceededError('wager_limit_exceeded', decision);
      }
    }

    // Real balance first, bonus for whatever it could not cover. The engine runs below the
    // duplicate-provider guard above, so a replayed wager can never buy wagering progress.
    const realPart = type === 'bet' && moneyCompare(available, amount) < 0 ? available : amount;
    const fromBonus = moneySubtract(amount, realPart);
    // A bet without both a context and a round id cannot be attributed to a grant or settled
    // back later, so it draws no bonus funds and earns no wagering progress - a plain debit
    // against the real balance, insufficient-funds if that balance cannot cover it.
    const wagered =
      type === 'bet' && this.ports.bonusWagering && context && providerRef?.externalRoundId
        ? await this.ports.bonusWagering.wager(txn, {
            userId,
            currency: debitCurrency,
            stake: amount,
            fromBonus,
            context,
            providerName: providerRef.providerName,
            externalRoundId: providerRef.externalRoundId,
          })
        : undefined;
    if (wagered && !wagered.ok) {
      // A stake over the grant's max bet is a refused bet, not a short balance. Reporting it as
      // insufficient funds would tell the player to deposit more, and a client that did would
      // hit the same wall with a bigger balance.
      if (wagered.reason === 'max_bet_exceeded') {
        throw new MaxBetExceededError(amount, wagered.maxBet);
      }
      return { ok: false, available: moneyAdd(available, wagered.bonusAvailable) };
    }
    if (moneyCompare(fromBonus, '0') > 0 && !wagered) {
      return { ok: false, available };
    }

    // The UPDATE ... RETURNING gives the new balance straight from Postgres numeric
    // arithmetic - no JS float math on either side of the debit. A stake paid entirely from
    // bonus funds touches no real balance at all, and must not be refused for not finding a
    // row to take zero from - the bonus is already spent by this point.
    const debited =
      type === 'bet' && moneyCompare(realPart, '0') <= 0
        ? [{ amount: available }]
        : await debitWalletBalance(txn, row.id, debitCurrency, type === 'bet' ? realPart : amount);
    const debitedBalance = debited[0]?.amount;
    if (debitedBalance === undefined) {
      return { ok: false, available };
    }

    // The ledger row carries the whole stake: a bet is a bet whichever balance paid for it.
    const { row: ledgerRow } = await this.writeLedgerRow(
      txn,
      debitRow,
      type,
      amount,
      'debit',
      providerRef,
    );

    if (!wagered) {
      return {
        ok: true,
        moved: true,
        transactionId: ledgerRow.id,
        newBalance: debitedBalance,
        currency: debitCurrency,
      };
    }

    const newBalance = wagered.completed
      ? await this.convertBonus(txn, debitRow, wagered.completed)
      : debitedBalance;

    return {
      ok: true,
      moved: true,
      transactionId: ledgerRow.id,
      newBalance,
      currency: debitCurrency,
      bonusSpent: wagered.bonusSpent,
      bonusBalance: wagered.bonusBalanceAfter,
      ...(wagered.completed === null ? {} : { completed: wagered.completed }),
      wagerTrackingCredits: wagered.walletCredits,
    };
  }

  /**
   * A grant that just met its requirement crosses into the real balance here rather than from
   * inside the engine: the wallet already holds the transaction, and a callback the other way
   * would make the two modules depend on each other in both directions.
   */
  private async convertBonus(
    txn: DrizzleDb,
    debitRow: Wallet & { currency: string },
    completed: { grantId: Uuid; convertedAmount: string },
  ): Promise<string> {
    const before = await readWalletBalance(txn, debitRow.id, debitRow.currency);
    const { grantId, convertedAmount } = completed;
    const [credited] = await creditWalletBalance(
      txn,
      debitRow.id,
      debitRow.currency,
      convertedAmount,
    );
    if (!credited) {
      throw new WalletBonusConversionError(debitRow.id, debitRow.currency);
    }
    await this.writeLedgerRow(txn, debitRow, 'bonus', convertedAmount, 'credit');
    // The one movement that turns a bonus into withdrawable money. A regulator asking who
    // released it reads this row, and it commits with the balance it describes.
    await this.audit.recordInTransaction(txn, {
      actorType: 'system',
      action: 'promo.bonus.converted',
      resourceType: 'promo_grant',
      resourceId: grantId,
      before: { currency: debitRow.currency, balance: before },
      after: { currency: debitRow.currency, balance: credited.amount, convertedAmount },
    });
    return credited.amount;
  }

  async credit(
    tx: unknown,
    {
      userId,
      amount,
      currency,
      type,
      allowNewCurrency,
      allowNewWallet,
      providerRef,
      terms,
    }: WalletCreditArgs,
  ): Promise<WalletCreditOutcome> {
    const txn = tx as DrizzleDb;

    if (type === 'win_reversal') {
      throw new WalletCorrectionTypeError(type);
    }
    if (Number(amount) <= 0) {
      throw new WalletCommandAmountError('credit', amount);
    }

    // A gift or rain only writes a bonus grant, so it leaves the wallet row unlocked: a rain debits its
    // sender and credits many recipients in one transaction.
    const bonusSource = type === 'gift' || type === 'rain';
    const row = allowNewWallet
      ? await this.resolveOrOpenWallet(txn, userId, currency, !bonusSource)
      : await this.selectWallet(txn, userId, !bonusSource);
    if (!row) {
      return { ok: false, reason: 'wallet not found' };
    }
    if (!allowNewCurrency && balanceKey(row.currency) !== balanceKey(currency)) {
      return { ok: false, reason: 'currency mismatch' };
    }

    // A win on a round that drew bonus funds belongs to the grant that funded it, or a forfeit
    // could never take "the winnings from that bonus" with it.
    //
    // Unlike a win, a reversal fails closed on a missing round id (mirroring `debit()`'s own
    // guard): defaulting to a full real credit here would release an un-wagered bonus stake as
    // cash while the wagering progress it bought stays on the grant. Checked before the ledger
    // row is written, the same as `debit()` refuses before writing anything.
    if (this.ports.bonusWagering && type === 'bet_reversal' && !providerRef?.externalRoundId) {
      return { ok: false, reason: 'bonus-funded reversal is missing a round id' };
    }

    const creditRow = { ...row, currency: balanceKey(currency) };

    // Gifted money is a bonus, not cash: it lands on a grant that has to be wagered before it
    // converts, so none of it reaches the real balance and none of it writes a `wallet_transaction`
    // row - that ledger is the real-money ledger, and a gift never moves real money. The grant's
    // own `(user_id, source, source_ref)` unique index is the idempotency guard, so it needs a
    // reference the caller can reproduce on a retry, never one this method invents for itself.
    if (bonusSource) {
      if (!this.ports.bonusGrants) {
        throw new WalletBonusEngineUnavailableError(type);
      }
      if (!providerRef?.providerRefId) {
        throw new WalletBonusSourceRefRequiredError(type);
      }
      const granted = await this.ports.bonusGrants.grant(txn, {
        userId,
        currency: balanceKey(currency),
        amount,
        source: type,
        sourceRef: providerRef.providerRefId,
        actor: { type: 'system' },
        terms,
      });
      if (!granted.ok) {
        throw new WalletBonusGrantRefusedError(granted.reason);
      }
      return {
        ok: true,
        moved: false,
        newBalance: await readWalletBalance(txn, row.id, balanceKey(currency)),
      };
    }

    // The wallet row lock above orders a credit before a correction or hold in the same
    // transaction, and its NO KEY UPDATE strength still lets another transaction insert a ledger row.
    const { row: ledgerRow, replayed } = await this.writeLedgerRow(
      txn,
      creditRow,
      type,
      amount,
      'credit',
      providerRef,
    );
    if (replayed) {
      const currentBalance = await readWalletBalance(txn, row.id, balanceKey(currency));
      return { ok: true, moved: false, newBalance: currentBalance };
    }

    // Locked before the settlement engine below ever locks `promo_grant`, so this path and
    // `debit()` (which locks `wallet_balance` before calling into the engine too) always take the
    // two locks in the same order - the opposite order on an ordinary concurrent bet and win/void
    // callback would deadlock and Postgres would abort one of the two transactions.
    await readWalletBalanceForUpdate(txn, row.id, balanceKey(currency));

    // The engine reports the real share rather than leaving this to compute `amount - bonusShare`:
    // a rollback callback for a round already returned has nothing left to give back, and
    // subtracting its zero bonus share would pay an un-wagered bonus stake out as spendable cash.
    const settlement =
      this.ports.bonusWagering &&
      providerRef?.externalRoundId &&
      (type === 'win' || type === 'bet_reversal')
        ? await this.ports.bonusWagering.settle(txn, {
            userId,
            currency: balanceKey(currency),
            amount,
            providerName: providerRef.providerName,
            externalRoundId: providerRef.externalRoundId,
            kind: type,
          })
        : { realShare: amount };

    const [credited] = await creditWalletBalance(txn, row.id, currency, settlement.realShare);
    if (!credited) {
      throw new WalletCreditFailedError(row.id, currency);
    }

    return { ok: true, moved: true, transactionId: ledgerRow.id, newBalance: credited.amount };
  }

  async correctionDebit(
    tx: unknown,
    { userId, amount, currency, type, providerRef }: WalletCorrectionDebitArgs,
  ): Promise<WalletCorrectionDebitOutcome> {
    const txn = tx as DrizzleDb;

    if (!WALLET_CORRECTION_DEBIT_TYPES.includes(type)) {
      throw new WalletCorrectionTypeError(type);
    }
    if (moneyCompare(amount, '0') <= 0) {
      throw new WalletCommandAmountError('correction debit', amount);
    }
    if (!providerRef.externalRoundId) {
      throw new WalletCorrectionRoundError(providerRef.providerName, providerRef.providerRefId);
    }

    const key = balanceKey(currency);
    const row = await this.selectWallet(txn, userId, true);
    if (!row) {
      return { moved: false, collected: '0', shortfall: amount, newBalance: '0' };
    }

    const replayed = await this.findByProviderRef(txn, providerRef);
    if (replayed) {
      if (
        !replayed.correction ||
        replayed.walletId !== row.id ||
        replayed.type !== type ||
        replayed.direction !== 'debit' ||
        replayed.currency !== key ||
        moneyCompare(amount, replayed.amount) < 0
      ) {
        throw new WalletCorrectionRefConflictError(
          providerRef.providerName,
          providerRef.providerRefId,
        );
      }
      return {
        moved: false,
        collected: replayed.amount,
        shortfall: moneySubtract(amount, replayed.amount),
        newBalance: await readWalletBalance(txn, row.id, key),
      };
    }

    // A savepoint, so a reference another wallet takes meanwhile puts the collected balance back
    // even when the caller catches the conflict and commits.
    return txn.transaction(async (sp) => {
      const taken = await collectWalletBalance(sp, row.id, key, amount);
      if (!taken) {
        return {
          moved: false,
          collected: '0',
          shortfall: amount,
          newBalance: await readWalletBalance(sp, row.id, key),
        };
      }

      // Only what was collected reaches the ledger; the shortfall is the caller's debt, not money that moved.
      const { row: ledgerRow, replayed: raced } = await this.writeLedgerRow(
        sp,
        { id: row.id, currency: key },
        type,
        taken.collected,
        'debit',
        providerRef,
        { correction: true },
      );
      if (raced) {
        throw new WalletCorrectionRefConflictError(
          providerRef.providerName,
          providerRef.providerRefId,
        );
      }

      return {
        moved: true,
        transactionId: ledgerRow.id,
        collected: taken.collected,
        shortfall: moneySubtract(amount, taken.collected),
        newBalance: taken.balance,
      };
    });
  }

  // Takes a wallet row lock that conflicts with the ones withdraw and approval read holds under,
  // so a payout either commits before the hold or sees it.
  async placeWithdrawalHold(
    tx: unknown,
    { userId, source, reason }: WalletWithdrawalHoldArgs,
  ): Promise<{ placed: boolean }> {
    const txn = tx as DrizzleDb;
    // With no wallet row there is nothing to lock, and a wallet opened meanwhile could pay out
    // before this hold commits.
    if (!(await this.selectWallet(txn, userId, true))) {
      throw new WalletHoldWithoutWalletError(userId);
    }
    const [inserted] = await txn
      .insert(walletWithdrawalHold)
      .values({ userId, source, reason })
      .onConflictDoNothing()
      .returning({ id: walletWithdrawalHold.id });
    if (inserted) {
      return { placed: true };
    }
    await txn
      .update(walletWithdrawalHold)
      .set({ reason })
      .where(and(eq(walletWithdrawalHold.userId, userId), eq(walletWithdrawalHold.source, source)));
    return { placed: false };
  }

  async releaseWithdrawalHold(
    tx: unknown,
    { userId, source }: Omit<WalletWithdrawalHoldArgs, 'reason'>,
  ): Promise<{ released: boolean }> {
    const txn = tx as DrizzleDb;
    await this.selectWallet(txn, userId, true);
    const deleted = await txn
      .delete(walletWithdrawalHold)
      .where(and(eq(walletWithdrawalHold.userId, userId), eq(walletWithdrawalHold.source, source)))
      .returning({ id: walletWithdrawalHold.id });
    return { released: deleted.length > 0 };
  }

  // NO KEY UPDATE leaves another transaction's ledger insert (a KEY SHARE on this row) unblocked.
  private async selectWallet(
    txn: DrizzleDb,
    userId: Uuid,
    lock: boolean,
  ): Promise<Wallet | undefined> {
    const query = txn.select().from(wallet).where(eq(wallet.userId, userId));
    const [row] = lock ? await query.for('no key update') : await query;
    return row;
  }

  private async resolveOrOpenWallet(
    txn: DrizzleDb,
    userId: Uuid,
    currency: string,
    lock: boolean,
  ): Promise<Wallet | undefined> {
    const existing = await this.selectWallet(txn, userId, lock);
    if (existing) {
      return existing;
    }
    const [created] = await txn
      .insert(wallet)
      .values({ userId, currency: balanceKey(currency) })
      .onConflictDoNothing()
      .returning();
    if (created) {
      return created;
    }
    return this.selectWallet(txn, userId, lock);
  }
}
