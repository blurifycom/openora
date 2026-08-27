import type {
  AuditWritePort,
  PlayEligibilityPort,
  RgLimitsPort,
  PlatformConfig,
  Uuid,
  WalletCommands,
  WalletDebitArgs,
  WalletDebitOutcome,
  WalletCreditArgs,
  WalletCreditOutcome,
  WalletTransactionType,
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

/**
 * A wager refused by the player's own wager or loss limit. The amount dimension of RG,
 * beside `WalletRgRestrictedError`'s exclusion dimension (ADR-0032). Carries typed
 * `data` so the client can translate it rather than read the message.
 */
export type WagerLimitExceededData = {
  limitType: string;
  period: string;
  limit: string;
  used: string;
};

export class WagerLimitExceededError extends Error {
  readonly data: WagerLimitExceededData;

  constructor(data: WagerLimitExceededData) {
    super(
      `Wager refused: it would exceed the ${data.period} ${data.limitType} limit of ${data.limit} (${data.used} already used)`,
    );
    this.name = 'WagerLimitExceededError';
    this.data = data;
  }
}

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

  async debit(tx: unknown, { userId, amount, type }: WalletDebitArgs): Promise<WalletDebitOutcome> {
    const txn = tx as DrizzleDb;

    if (type === 'bet') {
      if (await this.playEligibility.isRestricted(userId)) {
        throw new WalletRgRestrictedError();
      }
      // The only point where the stake is known, so the only place a wager/loss limit can
      // be applied. `win` and `loss` stay ungated for the ADR-0032 reason: they settle a
      // round that was already staked, and refusing them strands it.
      const decision = await this.rgLimits?.checkWager(userId, amount);
      if (decision && !decision.allowed) {
        throw new WagerLimitExceededError({
          limitType: decision.limitType,
          period: decision.period,
          limit: decision.limit,
          used: decision.used,
        });
      }
    }

    // `loss` is informational (stake already left at bet time): 0-amount row, balance untouched. Every other debit is real money.
    if (type !== 'loss' && Number(amount) <= 0) {
      throw new WalletCommandAmountError('debit', amount);
    }

    const [row] = await txn.select().from(wallet).where(eq(wallet.userId, userId)).for('update');
    if (!row) {
      return { ok: false, available: '0' };
    }
    const available = await readWalletBalance(txn, row.id, row.currency);

    if (type === 'loss') {
      await this.writeLedgerRow(txn, row, 'loss', '0', 'debit');
      return { ok: true, newBalance: available, currency: row.currency };
    }

    // The UPDATE ... RETURNING gives the new balance straight from Postgres numeric
    // arithmetic - no JS float math on either side of the debit.
    const debited =
      type === 'bet'
        ? await debitWalletBalance(txn, row.id, row.currency, amount)
        : await debitWithdrawableBalance(txn, row.id, row.currency, amount);
    const newBalance = debited[0]?.amount;
    if (newBalance === undefined) {
      return { ok: false, available };
    }

    await this.writeLedgerRow(txn, row, type, amount, 'debit');

    if (type === 'bet') {
      const completedBonusCredits = await this.applyBonusRolloverProgress(txn, {
        userId,
        currency: balanceKey(row.currency),
        amount,
      });
      return { ok: true, newBalance, currency: row.currency, completedBonusCredits };
    }

    return { ok: true, newBalance, currency: row.currency };
  }

  async credit(
    tx: unknown,
    { userId, amount, currency, type }: WalletCreditArgs,
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
    if (row.currency !== currency) {
      return { ok: false, reason: 'currency mismatch' };
    }

    const [credited] = await creditWalletBalance(txn, row.id, currency, amount);
    if (!credited) {
      throw new Error('wallet credit: no row');
    }

    await this.writeLedgerRow(txn, row, type, amount, 'credit');

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
