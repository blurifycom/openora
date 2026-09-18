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
  type WalletProviderRef,
  type WalletTransactionType,
  type BonusWageringCommands,
} from '@openora/core/contracts';
import {
  createDomainError,
  makeConflictError,
  moneyAdd,
  moneyCompare,
  moneySubtract,
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
  type WalletTransaction,
} from '../schema/index.js';
import type { BonusCreditSourceType, ManualAdjustmentDirection } from '../contract/index.js';
import {
  creditWalletBalance,
  balanceKey,
  debitWithdrawableBalance,
  debitWalletBalance,
  providerRefCondition,
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
    private readonly rgLimits?: RgLimitsPort,
    private readonly bonusWagering?: BonusWageringCommands,
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
  ): Promise<{ row: WalletTransaction; replayed: boolean }> {
    const insertQuery = txn.insert(walletTransaction).values({
      walletId: row.id,
      type,
      amount,
      currency: row.currency,
      status: 'completed',
      direction,
      rail: railFor(row.currency, this.platformConfig?.wallet?.cryptoCurrencies),
      providerName: providerRef?.providerName,
      providerRefId: providerRef?.providerRefId,
      externalRoundId: providerRef?.externalRoundId,
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

    const debitCurrency = balanceKey(currency ?? row.currency);
    const debitRow = { ...row, currency: debitCurrency };

    const available = await readWalletBalance(txn, row.id, debitCurrency);

    if (type === 'loss') {
      await this.writeLedgerRow(txn, debitRow, 'loss', '0', 'debit', providerRef);
      return { ok: true, newBalance: available, currency: debitCurrency };
    }

    // Must run before checkWager below - a replay must never re-evaluate the wager limit
    // against spend it already committed.
    if (providerRef && (await this.findByProviderRef(txn, providerRef))) {
      return { ok: true, newBalance: available, currency: debitCurrency };
    }

    if (type === 'bet' && this.rgLimits) {
      const decision = await this.rgLimits.checkWager(
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
    const wagered =
      type === 'bet' && this.bonusWagering
        ? await this.bonusWagering.wager(txn, {
            userId,
            currency: debitCurrency,
            stake: amount,
            fromBonus,
            context: context ?? { provider: 'wallet' },
            ...(providerRef?.externalRoundId === undefined
              ? {}
              : { externalRoundId: providerRef.externalRoundId }),
          })
        : undefined;
    if (wagered && !wagered.ok) {
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
      type === 'bet'
        ? moneyCompare(realPart, '0') > 0
          ? await debitWalletBalance(txn, row.id, debitCurrency, realPart)
          : [{ amount: available }]
        : await debitWithdrawableBalance(txn, row.id, debitCurrency, amount);
    const debitedBalance = debited[0]?.amount;
    if (debitedBalance === undefined) {
      return { ok: false, available };
    }

    // The ledger row carries the whole stake: a bet is a bet whichever balance paid for it.
    await this.writeLedgerRow(txn, debitRow, type, amount, 'debit', providerRef);

    // The older fungible rollover model, still running alongside the grant engine until the
    // chat-gift and rain paths move across. It reads `wallet_balance`, which grant money never
    // enters, so the two cannot double-count the same bet.
    const completedBonusCredits =
      type === 'bet'
        ? await this.applyBonusRolloverProgress(txn, {
            userId,
            currency: debitCurrency,
            amount,
          })
        : undefined;

    if (!wagered) {
      return {
        ok: true,
        newBalance: debitedBalance,
        currency: debitCurrency,
        ...(completedBonusCredits === undefined ? {} : { completedBonusCredits }),
      };
    }

    const newBalance =
      moneyCompare(wagered.convertedAmount, '0') > 0
        ? await this.convertBonus(txn, debitRow, wagered.convertedAmount)
        : debitedBalance;

    return {
      ok: true,
      newBalance,
      currency: debitCurrency,
      ...(completedBonusCredits === undefined ? {} : { completedBonusCredits }),
      bonusSpent: wagered.bonusSpent,
      bonusBalance: wagered.bonusBalanceAfter,
      completedGrantIds: wagered.completedGrantIds,
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
    amount: string,
  ): Promise<string> {
    const [credited] = await creditWalletBalance(txn, debitRow.id, debitRow.currency, amount);
    if (!credited) {
      throw new Error('wallet bonus conversion: no row');
    }
    await this.writeLedgerRow(txn, debitRow, 'bonus', amount, 'credit');
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
    }: WalletCreditArgs,
  ): Promise<WalletCreditOutcome> {
    const txn = tx as DrizzleDb;

    if (Number(amount) <= 0) {
      throw new WalletCommandAmountError('credit', amount);
    }

    const row = allowNewWallet
      ? await this.resolveOrOpenWallet(txn, userId, currency)
      : (await txn.select().from(wallet).where(eq(wallet.userId, userId)))[0];
    if (!row) {
      return { ok: false, reason: 'wallet not found' };
    }
    if (!allowNewCurrency && balanceKey(row.currency) !== balanceKey(currency)) {
      return { ok: false, reason: 'currency mismatch' };
    }

    const creditRow = { ...row, currency: balanceKey(currency) };

    // Unlike debit(), credit() takes no row lock, so the ledger row is inserted (and its
    // conflict resolved) before the balance mutation rather than after.
    const { replayed } = await this.writeLedgerRow(
      txn,
      creditRow,
      type,
      amount,
      'credit',
      providerRef,
    );
    if (replayed) {
      const currentBalance = await readWalletBalance(txn, row.id, balanceKey(currency));
      return { ok: true, newBalance: currentBalance };
    }

    // A win on a round that drew bonus funds belongs to the grant that funded it, or a forfeit
    // could never take "the winnings from that bonus" with it. Below the replay guard above.
    const bonusShare =
      this.bonusWagering &&
      providerRef?.externalRoundId &&
      (type === 'win' || type === 'bet_reversal')
        ? (
            await this.bonusWagering.settle(txn, {
              userId,
              currency,
              amount,
              externalRoundId: providerRef.externalRoundId,
              kind: type,
            })
          ).bonusShare
        : '0';

    const [credited] = await creditWalletBalance(
      txn,
      row.id,
      currency,
      moneySubtract(amount, bonusShare),
    );
    if (!credited) {
      throw new Error('wallet credit: no row');
    }

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

  private async resolveOrOpenWallet(
    txn: DrizzleDb,
    userId: Uuid,
    currency: string,
  ): Promise<Wallet | undefined> {
    const [existing] = await txn.select().from(wallet).where(eq(wallet.userId, userId));
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
    const [raced] = await txn.select().from(wallet).where(eq(wallet.userId, userId));
    return raced;
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
