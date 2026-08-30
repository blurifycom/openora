import {
  RgLimitExceededError,
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
  type WalletTransactionType,
} from '@openora/core/contracts';
import {
  createDomainError,
  makeConflictError,
  moneyToNumber,
  type DrizzleDb,
} from '@openora/core/server';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  wallet,
  walletTransaction,
  walletBonusCredit,
  walletBonusRolloverConfig,
  type Wallet,
} from '../schema/index.js';
import type { BonusCreditSourceType, ManualAdjustmentDirection } from '../contract/index.js';
import {
  creditWalletBalance,
  balanceKey,
  debitWithdrawableBalance,
  debitWalletBalance,
  railFor,
  readWalletBalance,
} from './wallet.service.js';

export const WalletCommandAmountError = createDomainError<[operation: string, amount: string]>(
  'WalletCommandAmountError',
  (operation, amount) => `wallet ${operation} amount must be positive (got ${amount})`,
);

// Default in-process WALLET_COMMANDS implementation. Operates on the caller's
// transaction handle, so a move commits or rolls back together with the caller's
// other writes - the same atomicity the cross-module schema-write gave, now behind
// a port the wallet module owns. Every move writes a `wallet_transaction` ledger row
// (status `completed`, internal settlement so no provider ref) so gameplay shows in
// transaction history. The `balance >= amount` guard in the UPDATE makes concurrent
// debits safe (a lost race updates zero rows and we report the shortfall).
export const WalletRgRestrictedError = makeConflictError(
  'WalletRgRestrictedError',
  'wager is restricted by an active responsible-gambling exclusion',
);

const DEFAULT_ROLLOVER_MULTIPLIER = '1';

type CompletedBonusCredit = { id: string; currency: string; creditedAmount: string };

export class WalletCommandsService implements WalletCommands {
  constructor(
    private readonly playEligibility: PlayEligibilityPort,
    private readonly audit: AuditWritePort,
    private readonly platformConfig?: PlatformConfig,
    // Optional, like the port itself: an install without the compliance module has no
    // `user_limit` table and nothing to enforce. Bound, the gate is fail-closed.
    private readonly rgLimits?: RgLimitsPort,
  ) {}

  // Completed, internal-settlement ledger row (no provider ref) shared by every gameplay move.
  // `direction` is required (not optional) so a new call site can't compile without deciding
  // it - `debit()` always passes 'debit', `credit()` always passes 'credit', including the
  // gift/rain/tip legs that share one `type` for both sides of the transfer.
  private writeLedgerRow(
    txn: DrizzleDb,
    row: { id: string; currency: string },
    type: WalletTransactionType,
    amount: string,
    direction: ManualAdjustmentDirection,
  ) {
    return txn.insert(walletTransaction).values({
      walletId: row.id,
      type,
      amount,
      currency: row.currency,
      status: 'completed',
      direction,
      rail: railFor(row.currency, this.platformConfig?.wallet?.cryptoCurrencies),
    });
  }

  async debit(
    tx: unknown,
    { userId, amount, type, currency }: WalletDebitArgs,
  ): Promise<WalletDebitOutcome> {
    const txn = tx as DrizzleDb;

    if (type === 'bet' && (await this.playEligibility.isRestricted(userId))) {
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

    // Deliberately AFTER the `FOR UPDATE` above, not at the top of this method: the limit
    // check is a read, so checking it before taking the lock lets two concurrent bets see
    // the same usage and both pass. Under the lock the second one waits for the first to
    // commit its round, and reads it. This is the only point where the stake is known,
    // and the only place a wager limit can actually be held.
    //
    // `win` and `loss` stay ungated for the ADR-0032 reason: they settle a round that was
    // already staked, and refusing them strands it.
    if (type === 'bet' && this.rgLimits) {
      const decision = await this.rgLimits.checkWager(userId, amount, currency ?? row.currency);
      if (!decision.allowed) {
        throw new RgLimitExceededError('wager_limit_exceeded', decision);
      }
    }

    // Absent `currency` the debit falls on the player's active balance, which is what
    // every caller wanted before a swap needed to sell a specific asset. `debitRow` only
    // exists to carry that choice into the ledger row and the rail classification - the
    // wallet row itself is untouched, so debiting BTC does not move the active currency.
    const debitCurrency = balanceKey(currency ?? row.currency);
    const debitRow = { ...row, currency: debitCurrency };

    const available = await readWalletBalance(txn, row.id, debitCurrency);

    if (type === 'loss') {
      await this.writeLedgerRow(txn, debitRow, 'loss', '0', 'debit');
      return { ok: true, newBalance: available, currency: debitCurrency };
    }

    // The UPDATE ... RETURNING gives the new balance straight from Postgres numeric
    // arithmetic - no JS float math on either side of the debit.
    const debited =
      type === 'bet'
        ? await debitWalletBalance(txn, row.id, debitCurrency, amount)
        : await debitWithdrawableBalance(txn, row.id, debitCurrency, amount);
    const newBalance = debited[0]?.amount;
    if (newBalance === undefined) {
      return { ok: false, available };
    }

    await this.writeLedgerRow(txn, debitRow, type, amount, 'debit');

    if (type === 'bet') {
      const completedBonusCredits = await this.applyBonusRolloverProgress(txn, {
        userId,
        currency: debitCurrency,
        amount,
      });
      return { ok: true, newBalance, currency: debitCurrency, completedBonusCredits };
    }

    return { ok: true, newBalance, currency: debitCurrency };
  }

  async credit(
    tx: unknown,
    { userId, amount, currency, type, allowNewCurrency }: WalletCreditArgs,
  ): Promise<WalletCreditOutcome> {
    const txn = tx as DrizzleDb;

    if (Number(amount) <= 0) {
      throw new WalletCommandAmountError('credit', amount);
    }

    const [row] = await txn.select().from(wallet).where(eq(wallet.userId, userId));
    // Fail closed: a credit never creates a wallet - a missing one is a caller bug.
    if (!row) {
      return { ok: false, reason: 'wallet not found' };
    }
    // A currency that is not the player's own is a caller bug for every path except a
    // swap, where buying an asset the player has never held is the whole point. Keep the
    // guard on by default and let the swap opt out explicitly, rather than dropping a
    // check that has been catching mistakes for every other caller.
    if (!allowNewCurrency && balanceKey(row.currency) !== balanceKey(currency)) {
      return { ok: false, reason: 'currency mismatch' };
    }

    const creditRow = { ...row, currency: balanceKey(currency) };
    const [credited] = await creditWalletBalance(txn, row.id, currency, amount);
    if (!credited) {
      throw new Error('wallet credit: no row');
    }

    await this.writeLedgerRow(txn, creditRow, type, amount, 'credit');

    if (type === 'gift' || type === 'rain') {
      await this.createBonusCredit(txn, {
        walletId: row.id,
        userId,
        currency,
        amount,
        sourceType: type,
      });
    }

    return { ok: true, newBalance: credited.amount };
  }

  private async resolveRolloverMultiplier(txn: DrizzleDb): Promise<string> {
    const [row] = await txn
      .select({ multiplier: walletBonusRolloverConfig.multiplier })
      .from(walletBonusRolloverConfig)
      .where(eq(walletBonusRolloverConfig.singletonKey, 'global'));
    return row?.multiplier ?? DEFAULT_ROLLOVER_MULTIPLIER;
  }

  private async createBonusCredit(
    txn: DrizzleDb,
    {
      walletId,
      userId,
      currency,
      amount,
      sourceType,
    }: {
      walletId: Wallet['id'];
      userId: Uuid;
      currency: string;
      amount: string;
      sourceType: BonusCreditSourceType;
    },
  ): Promise<void> {
    const multiplier = await this.resolveRolloverMultiplier(txn);

    const [creditRow] = await txn
      .insert(walletBonusCredit)
      .values({
        walletId,
        userId,
        currency: balanceKey(currency),
        sourceType,
        creditedAmount: amount,
        rolloverMultiplier: multiplier,
        rolloverRequired: sql`(${amount}::numeric * ${multiplier}::numeric)`,
        rolloverProgress: '0',
        status: 'active',
      })
      .returning();
    if (!creditRow) {
      throw new Error('wallet bonus credit: no row');
    }

    await this.audit.recordInTransaction(txn, {
      actorType: 'system',
      action: 'wallet.bonus_credit.created',
      resourceType: 'wallet_bonus_credit',
      resourceId: creditRow.id,
      after: {
        userId,
        currency: balanceKey(currency),
        sourceType,
        creditedAmount: amount,
        rolloverMultiplier: multiplier,
        rolloverRequired: creditRow.rolloverRequired,
      },
    });
  }

  private async applyBonusRolloverProgress(
    txn: DrizzleDb,
    { userId, currency, amount }: { userId: Uuid; currency: string; amount: string },
  ): Promise<CompletedBonusCredit[]> {
    const activeCredits = await txn
      .select({ id: walletBonusCredit.id })
      .from(walletBonusCredit)
      .where(
        and(
          eq(walletBonusCredit.userId, userId),
          eq(walletBonusCredit.currency, balanceKey(currency)),
          eq(walletBonusCredit.status, 'active'),
        ),
      )
      .orderBy(asc(walletBonusCredit.createdAt), asc(walletBonusCredit.id));

    const completed: CompletedBonusCredit[] = [];
    let remaining = amount;

    for (const credit of activeCredits) {
      if (moneyToNumber(remaining) <= 0) {
        break;
      }

      const [locked] = await txn
        .select({ rolloverProgress: walletBonusCredit.rolloverProgress })
        .from(walletBonusCredit)
        .where(and(eq(walletBonusCredit.id, credit.id), eq(walletBonusCredit.status, 'active')))
        .for('update');

      if (!locked) {
        continue;
      }

      const [updated] = await txn
        .update(walletBonusCredit)
        .set({
          rolloverProgress: sql`LEAST(${walletBonusCredit.rolloverRequired}, ${walletBonusCredit.rolloverProgress} + ${remaining}::numeric)`,
          status: sql`(CASE WHEN ${walletBonusCredit.rolloverProgress} + ${remaining}::numeric >= ${walletBonusCredit.rolloverRequired} THEN 'completed' ELSE 'active' END)::wallet_bonus_credit_status`,
          completedAt: sql`CASE WHEN ${walletBonusCredit.rolloverProgress} + ${remaining}::numeric >= ${walletBonusCredit.rolloverRequired} THEN now() ELSE ${walletBonusCredit.completedAt} END`,
        })
        .where(and(eq(walletBonusCredit.id, credit.id), eq(walletBonusCredit.status, 'active')))
        .returning({
          id: walletBonusCredit.id,
          status: walletBonusCredit.status,
          currency: walletBonusCredit.currency,
          creditedAmount: walletBonusCredit.creditedAmount,
          rolloverRequired: walletBonusCredit.rolloverRequired,
          rolloverProgress: walletBonusCredit.rolloverProgress,
          remainingAfter: sql<string>`(${remaining}::numeric - (${walletBonusCredit.rolloverProgress} - ${locked.rolloverProgress}::numeric))::text`,
        });

      if (!updated) {
        continue;
      }

      remaining = updated.remainingAfter;

      if (updated.status === 'completed') {
        completed.push({
          id: updated.id,
          currency: updated.currency,
          creditedAmount: updated.creditedAmount,
        });
        await this.audit.recordInTransaction(txn, {
          actorType: 'system',
          action: 'wallet.bonus_credit.completed',
          resourceType: 'wallet_bonus_credit',
          resourceId: updated.id,
          before: { status: 'active', rolloverProgress: locked.rolloverProgress },
          after: {
            userId,
            currency: updated.currency,
            creditedAmount: updated.creditedAmount,
            rolloverRequired: updated.rolloverRequired,
            rolloverProgress: updated.rolloverProgress,
            status: updated.status,
          },
        });
      }
    }

    return completed;
  }
}
