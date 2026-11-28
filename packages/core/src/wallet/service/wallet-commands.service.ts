import {
  MaxBetExceededError,
  RgLimitExceededError,
  WALLET_BET_ALREADY_REVERSED,
  WALLET_REVERSAL_UNMATCHED,
  WALLET_CORRECTION_DEBIT_TYPES,
  WALLET_LOCK_EXEMPT_DEBIT_TYPES,
  WALLET_TRANSFER_CREDIT_KINDS,
  WalletCommandAmountError,
  WalletCorrectionExceedsRoundError,
  WalletCorrectionRefConflictError,
  WalletCorrectionRoundError,
  WalletCorrectionTypeError,
  WalletHoldWithoutWalletError,
  type AddTurnoverRequirementArgs,
  type AddTurnoverRequirementResult,
  type AuditWritePort,
  type BonusFundLockCommands,
  type MovableFunds,
  type MovableFundsArgs,
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
  type WalletCorrectionDebitType,
  type WalletProviderRef,
  type WalletWithdrawalHoldArgs,
  type WalletTransactionType,
  type BonusGrantCommands,
  type BonusWageringCommands,
  type BonusCompletion,
  type WalletCloseRoundArgs,
  type IdentityReader,
  isPlayRefused,
  type WagerContext,
  isWagerRtp,
  isTurnoverEnabled,
  resolveWalletTurnoverConfig,
  TurnoverDisabledError,
  type WalletConfig,
  UuidSchema,
  WalletReplayMismatchError,
} from '@openora/core/contracts';
import {
  createDomainError,
  isPositiveMoney,
  makeConflictError,
  moneyAdd,
  moneyCompare,
  moneyEquals,
  moneySubtract,
  type DrizzleDb,
} from '@openora/core/server';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  wallet,
  walletTransaction,
  walletWithdrawalHold,
  type Wallet,
  type WalletTransaction,
} from '../schema/index.js';
import type { ManualAdjustmentDirection } from '../contract/index.js';
import type { TurnoverService, TurnoverStakeStamp } from './turnover.service.js';
import {
  creditWalletBalance,
  balanceKey,
  collectWalletBalance,
  debitWalletBalance,
  providerRefCondition,
  namespacedIdempotencyKey,
  railFor,
  readWalletBalance,
  readWalletBalanceForUpdate,
  stampBalanceAfter,
} from './wallet.service.js';

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

const WalletReferralRewardRefRequiredError = createDomainError(
  'WalletReferralRewardRefRequiredError',
  () =>
    'a referral_reward credit needs a stable providerRef.providerRefId so a retry cannot pay twice',
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

type LedgerRequest = {
  walletId: Wallet['id'];
  type: WalletTransactionType;
  direction: ManualAdjustmentDirection;
  amount: string;
  currency: string | undefined;
  externalRoundId: string | undefined;
};

class DebitRefused extends Error {
  constructor(readonly available: string) {
    super('debit refused');
    this.name = 'DebitRefused';
  }
}

export function assertReplayMatches(
  stored: WalletTransaction,
  request: LedgerRequest,
  providerRef: WalletProviderRef,
): void {
  const matches =
    stored.correctionRequestedAmount === null &&
    stored.walletId === request.walletId &&
    stored.type === request.type &&
    (stored.direction ?? request.direction) === request.direction &&
    (request.currency === undefined || balanceKey(stored.currency) === request.currency) &&
    (stored.externalRoundId === null || stored.externalRoundId === request.externalRoundId) &&
    moneyEquals(stored.amount, request.amount);
  if (!matches) {
    throw new WalletReplayMismatchError(
      providerRef.providerName,
      providerRef.providerRefId,
      stored.id,
    );
  }
}

class ReversalRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export type WalletCommandsPorts = {
  platformConfig?: PlatformConfig;
  rgLimits?: RgLimitsPort;
  bonusWagering?: BonusWageringCommands;
  bonusGrants?: BonusGrantCommands;
  bonusFundLocks?: BonusFundLockCommands;
  identityReader?: IdentityReader;
  turnover?: () => TurnoverService;
};

const isLockExemptDebit = (type: WalletTransactionType): boolean =>
  (WALLET_LOCK_EXEMPT_DEBIT_TYPES as readonly WalletTransactionType[]).includes(type);

type TransferCreditType = (typeof WALLET_TRANSFER_CREDIT_KINDS)[number];
const isTransferCredit = (type: WalletTransactionType): type is TransferCreditType =>
  (WALLET_TRANSFER_CREDIT_KINDS as readonly WalletTransactionType[]).includes(type);

const TRANSFER_CREDIT_NAMESPACE = 'transfer-credit';

export function cashTransferKindsWithoutTurnover(
  config: WalletConfig | undefined,
): TransferCreditType[] {
  if (config?.transferCredits !== 'cash') {
    return [];
  }
  const turnover = resolveWalletTurnoverConfig(config);
  if (!isTurnoverEnabled(turnover)) {
    return [...WALLET_TRANSFER_CREDIT_KINDS];
  }
  return WALLET_TRANSFER_CREDIT_KINDS.filter((kind) => !turnover.creditTypes.includes(kind));
}

export class WalletCommandsService implements WalletCommands {
  private readonly significantAmountThresholds: ReadonlyMap<string, string>;
  private readonly turnoverOn: boolean;

  constructor(
    private readonly playEligibility: PlayEligibilityPort,
    private readonly audit: AuditWritePort,
    private readonly ports: WalletCommandsPorts = {},
  ) {
    this.significantAmountThresholds = new Map(
      Object.entries(ports.platformConfig?.wallet?.significantAmountThresholds ?? {}).map(
        ([currency, threshold]) => [balanceKey(currency), threshold],
      ),
    );
    this.turnoverOn = isTurnoverEnabled(resolveWalletTurnoverConfig(ports.platformConfig?.wallet));
  }

  private activeTurnover(): TurnoverService | undefined {
    return this.turnoverOn ? this.ports.turnover?.() : undefined;
  }

  private async auditSignificantAmount(
    txn: DrizzleDb,
    action: 'wallet.large_bet.recorded' | 'wallet.large_win.recorded',
    userId: Uuid,
    ledgerRow: WalletTransaction,
    balance: { before: string; after: string },
  ): Promise<void> {
    const threshold = this.significantAmountThresholds.get(balanceKey(ledgerRow.currency));
    if (threshold === undefined || moneyCompare(ledgerRow.amount, threshold) < 0) {
      return;
    }
    await this.audit.recordInTransaction(txn, {
      actorType: 'system',
      action,
      resourceType: 'wallet_transaction',
      resourceId: ledgerRow.id,
      before: { balance: balance.before },
      after: {
        userId,
        amount: ledgerRow.amount,
        currency: ledgerRow.currency,
        balance: balance.after,
        threshold,
        providerName: ledgerRow.providerName,
        providerRefId: ledgerRow.providerRefId,
        externalRoundId: ledgerRow.externalRoundId,
      },
    });
  }

  private async writeLedgerRow(
    txn: DrizzleDb,
    row: { id: string; currency: string },
    type: WalletTransactionType,
    amount: string,
    direction: ManualAdjustmentDirection,
    providerRef?: WalletProviderRef,
    balanceAfter?: string,
    {
      correctionRequestedAmount,
      wager,
      realShare,
      reversedTransactionId,
      turnover,
    }: {
      correctionRequestedAmount?: string;
      wager?: WagerContext;
      realShare?: string;
      reversedTransactionId?: string;
      turnover?: TurnoverStakeStamp | null;
    } = {},
  ): Promise<{ row: WalletTransaction; replayed: boolean }> {
    const insertQuery = txn.insert(walletTransaction).values({
      walletId: row.id,
      type,
      amount,
      currency: row.currency,
      balanceAfter,
      status: 'completed',
      direction,
      rail: railFor(row.currency, this.ports.platformConfig?.wallet?.cryptoCurrencies),
      providerName: providerRef?.providerName,
      providerRefId: providerRef?.providerRefId,
      externalRoundId: providerRef?.externalRoundId,
      correctionRequestedAmount,
      realShare,
      reversedTransactionId,
      turnoverContribution: turnover?.contribution,
      turnoverState: turnover?.state,
      wagerProduct: wager?.product,
      wagerRtp: wager?.rtp !== undefined && isWagerRtp(wager.rtp) ? wager.rtp : undefined,
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

  private async writeTransferCreditRow({
    txn,
    row,
    type,
    amount,
    providerRef,
  }: {
    txn: DrizzleDb;
    row: { id: string; currency: string };
    type: TransferCreditType;
    amount: string;
    providerRef: WalletProviderRef;
  }): Promise<{ row: WalletTransaction; replayed: boolean }> {
    const idempotencyKey = namespacedIdempotencyKey(
      TRANSFER_CREDIT_NAMESPACE,
      JSON.stringify([type, providerRef.providerName, providerRef.providerRefId]),
    );
    const [inserted] = await txn
      .insert(walletTransaction)
      .values({
        walletId: row.id,
        type,
        amount,
        currency: row.currency,
        status: 'completed',
        direction: 'credit',
        rail: railFor(row.currency, this.ports.platformConfig?.wallet?.cryptoCurrencies),
        providerName: providerRef.providerName,
        idempotencyKey,
        metadata: JSON.stringify({ providerRefId: providerRef.providerRefId }),
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      return { row: inserted, replayed: false };
    }
    const [existing] = await txn
      .select()
      .from(walletTransaction)
      .where(
        and(
          eq(walletTransaction.walletId, row.id),
          eq(walletTransaction.idempotencyKey, idempotencyKey),
        ),
      );
    if (!existing) {
      throw new Error(`wallet ledger row: ${type} credit conflict but no row found`);
    }
    return { row: existing, replayed: true };
  }

  async debit(
    tx: unknown,
    { userId, amount, type, currency, providerRef, context }: WalletDebitArgs,
  ): Promise<WalletDebitOutcome> {
    const txn = tx as DrizzleDb;

    if (type === 'win_reversal') {
      throw new WalletCorrectionTypeError(type);
    }
    if (type === 'bet' && (await isPlayRefused(this.playEligibility, userId, txn))) {
      throw new WalletRgRestrictedError();
    }

    if (type !== 'loss' && !isPositiveMoney(amount)) {
      throw new WalletCommandAmountError('debit', amount);
    }

    const [row] = await txn.select().from(wallet).where(eq(wallet.userId, userId)).for('update');
    if (!row) {
      return { ok: false, available: '0' };
    }

    const debitCurrency = balanceKey(currency ?? row.currency);
    const debitRow = { ...row, currency: debitCurrency };

    const available = await readWalletBalanceForUpdate(txn, row.id, debitCurrency);

    const request: LedgerRequest = {
      walletId: row.id,
      type,
      direction: 'debit',
      amount,
      currency: currency === undefined ? undefined : debitCurrency,
      externalRoundId: providerRef?.externalRoundId,
    };
    const replay = async (
      stored: WalletTransaction,
      ref: WalletProviderRef,
      asked: LedgerRequest,
    ): Promise<WalletDebitOutcome> => {
      assertReplayMatches(stored, asked, ref);
      const storedCurrency = balanceKey(stored.currency);
      return {
        ok: true,
        moved: false,
        newBalance:
          storedCurrency === debitCurrency
            ? available
            : await readWalletBalance(txn, row.id, storedCurrency),
        currency: storedCurrency,
        replayedTransactionId: stored.id,
      };
    };

    if (type === 'loss') {
      const loss = await this.writeLedgerRow(
        txn,
        debitRow,
        'loss',
        '0',
        'debit',
        providerRef,
        available,
      );
      if (loss.replayed && providerRef) {
        return replay(loss.row, providerRef, { ...request, amount: '0' });
      }
      const closed =
        this.ports.bonusWagering && providerRef?.externalRoundId
          ? await this.ports.bonusWagering.closeRound(txn, {
              userId,
              currency: debitCurrency,
              providerName: providerRef.providerName,
              externalRoundId: providerRef.externalRoundId,
              realBalance: available,
            })
          : { completed: [] };
      const newBalance = await this.convertAll(txn, debitRow, closed.completed, available);
      if (providerRef?.externalRoundId) {
        await this.activeTurnover()?.settleRound(txn, {
          userId,
          walletId: row.id,
          currency: debitCurrency,
          providerName: providerRef.providerName,
          externalRoundId: providerRef.externalRoundId,
        });
      }
      return {
        ok: true,
        moved: false,
        newBalance,
        currency: debitCurrency,
        ...(closed.completed.length > 0 ? { completed: closed.completed } : {}),
      };
    }

    const stored = providerRef && (await this.findByProviderRef(txn, providerRef));
    if (stored) {
      return replay(stored, providerRef, request);
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

    const move = await txn
      .transaction(async (sp) => {
        const wagered =
          type === 'bet' && this.ports.bonusWagering && context && providerRef?.externalRoundId
            ? await this.ports.bonusWagering.wager(sp, {
                userId,
                currency: debitCurrency,
                stake: amount,
                realAvailable: available,
                context,
                providerName: providerRef.providerName,
                externalRoundId: providerRef.externalRoundId,
              })
            : undefined;
        if (wagered && !wagered.ok) {
          if (wagered.reason === 'max_bet_exceeded') {
            throw new MaxBetExceededError(amount, wagered.maxBet, wagered.roundStake);
          }
          if (wagered.reason === 'restricted_funds') {
            throw new DebitRefused(wagered.permitted);
          }
          throw new DebitRefused(moneyAdd(available, wagered.bonusAvailable));
        }
        const realPart = wagered ? moneySubtract(amount, wagered.bonusSpent) : amount;

        const debited =
          type === 'bet' && moneyCompare(realPart, '0') <= 0
            ? [{ amount: available }]
            : await debitWalletBalance(
                sp,
                row.id,
                debitCurrency,
                type === 'bet' ? realPart : amount,
              );
        const debitedBalance = debited[0]?.amount;
        if (debitedBalance === undefined) {
          throw new DebitRefused(available);
        }
        if (!isLockExemptDebit(type)) {
          const outflow = { userId, currency: debitCurrency, amount, balanceAfter: debitedBalance };
          await this.ports.bonusFundLocks?.onOutflow(
            sp,
            type === 'withdrawal'
              ? {
                  ...outflow,
                  outflow: 'withdrawal',
                  actor: { id: userId, isAdmin: false },
                  note: `withdrawal ${providerRef?.providerRefId ?? ''}`.trim(),
                }
              : { ...outflow, outflow: type === 'swap_out' ? 'swap' : 'transfer' },
          );
          if (type !== 'swap_out') {
            await this.activeTurnover()?.assertOutflow(sp, {
              userId,
              outflow: type === 'withdrawal' ? 'withdrawal' : 'transfer',
            });
          }
        }

        const turnover = this.activeTurnover();
        const stake =
          type === 'bet' && turnover
            ? await turnover.stakeStamp(sp, {
                userId,
                product: context?.product,
                currency: debitCurrency,
                realPart,
              })
            : null;
        const { row: ledgerRow, replayed } = await this.writeLedgerRow(
          sp,
          debitRow,
          type,
          amount,
          'debit',
          providerRef,
          debitedBalance,
          type === 'bet' ? { wager: context, realShare: realPart, turnover: stake } : {},
        );
        if (replayed && providerRef) {
          throw new WalletReplayMismatchError(
            providerRef.providerName,
            providerRef.providerRefId,
            ledgerRow.id,
          );
        }
        if (stake?.state === 'counted') {
          await turnover?.countStake(sp, stake);
        }
        return { wagered, ledgerRow, debitedBalance };
      })
      .catch((error: unknown) => {
        if (error instanceof DebitRefused) {
          return error;
        }
        throw error;
      });
    if (move instanceof DebitRefused) {
      return { ok: false, available: move.available };
    }
    const { wagered, ledgerRow, debitedBalance } = move;
    if (type === 'bet') {
      await this.auditSignificantAmount(txn, 'wallet.large_bet.recorded', userId, ledgerRow, {
        before: available,
        after: debitedBalance,
      });
    }

    if (!wagered) {
      return {
        ok: true,
        moved: true,
        transactionId: ledgerRow.id,
        newBalance: debitedBalance,
        currency: debitCurrency,
      };
    }

    return {
      ok: true,
      moved: true,
      transactionId: ledgerRow.id,
      newBalance: debitedBalance,
      currency: debitCurrency,
      bonusSpent: wagered.bonusSpent,
      bonusBalance: wagered.bonusBalanceAfter,
      wagerTrackingCredits: wagered.walletCredits,
    };
  }

  async addTurnoverRequirement(
    tx: unknown,
    args: AddTurnoverRequirementArgs,
  ): Promise<AddTurnoverRequirementResult> {
    if (!this.ports.turnover) {
      throw new TurnoverDisabledError();
    }
    return this.ports.turnover().addRequirement(tx, args);
  }

  async lockWallets(tx: unknown, { userIds }: { userIds: readonly string[] }): Promise<void> {
    if (userIds.length === 0) {
      return;
    }
    await (tx as DrizzleDb)
      .select({ id: wallet.id })
      .from(wallet)
      .where(inArray(wallet.userId, [...new Set(userIds)]))
      .orderBy(asc(wallet.userId))
      .for('update');
  }

  async movableFunds(tx: unknown, { userId, currency }: MovableFundsArgs): Promise<MovableFunds> {
    const txn = tx as DrizzleDb;
    const key = balanceKey(currency);
    const [row] = await txn.select().from(wallet).where(eq(wallet.userId, userId)).for('update');
    if (!row) {
      return { real: '0', locked: '0', free: '0' };
    }
    const real = await readWalletBalanceForUpdate(txn, row.id, key);
    const bonus = this.ports.bonusFundLocks
      ? await this.ports.bonusFundLocks.lockedFunds(txn, {
          userId,
          currency: key,
          realBalance: real,
        })
      : { locked: '0', free: real };
    const turnover = this.activeTurnover();
    if (turnover && (await turnover.refusal(txn, { userId, outflow: 'transfer' }))) {
      return isPositiveMoney(real)
        ? { real, locked: real, free: '0', lockedBy: 'turnover' }
        : { real, locked: real, free: '0' };
    }
    return isPositiveMoney(bonus.locked)
      ? { real, ...bonus, lockedBy: 'bonus' }
      : { real, ...bonus };
  }

  private async convertAll(
    txn: DrizzleDb,
    debitRow: Wallet & { currency: string },
    completed: readonly BonusCompletion[],
    balance: string,
  ): Promise<string> {
    let newBalance = balance;
    for (const completion of completed) {
      if (moneyCompare(completion.convertedAmount, '0') > 0) {
        newBalance = await this.convertBonus(txn, debitRow, completion);
      }
    }
    return newBalance;
  }

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
    await this.writeLedgerRow(
      txn,
      debitRow,
      'bonus',
      convertedAmount,
      'credit',
      undefined,
      credited.amount,
    );
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

  credit(tx: unknown, args: WalletCreditArgs): Promise<WalletCreditOutcome> {
    return args.type === 'bet_reversal'
      ? (tx as DrizzleDb).transaction((t) => this.creditIn(t, args))
      : this.creditIn(tx as DrizzleDb, args);
  }

  private async creditIn(
    txn: DrizzleDb,
    {
      userId,
      amount,
      currency,
      type,
      allowNewCurrency,
      allowNewWallet,
      providerRef,
      terms,
      reversesTransactionId,
      closesRound,
    }: WalletCreditArgs,
  ): Promise<WalletCreditOutcome> {
    if (type === 'win_reversal') {
      throw new WalletCorrectionTypeError(type);
    }
    if (!isPositiveMoney(amount)) {
      throw new WalletCommandAmountError('credit', amount);
    }
    if (type === 'referral_reward' && !providerRef?.providerRefId) {
      throw new WalletReferralRewardRefRequiredError();
    }

    const transfer = isTransferCredit(type) ? type : null;
    const cashTransfer =
      transfer !== null && this.ports.platformConfig?.wallet?.transferCredits === 'cash'
        ? transfer
        : null;
    const bonusSource = cashTransfer === null ? transfer : null;
    if (cashTransfer !== null && !providerRef?.providerRefId) {
      throw new WalletBonusSourceRefRequiredError(type);
    }
    const row = allowNewWallet
      ? await this.resolveOrOpenWallet(txn, userId, currency, bonusSource === null)
      : await this.selectWallet(txn, userId, bonusSource === null);
    if (!row) {
      return { ok: false, reason: 'wallet not found' };
    }
    if (!allowNewCurrency && balanceKey(row.currency) !== balanceKey(currency)) {
      return { ok: false, reason: 'currency mismatch' };
    }

    if (
      type === 'bet_reversal' &&
      !providerRef?.externalRoundId &&
      (this.ports.bonusWagering || !reversesTransactionId)
    ) {
      return { ok: false, reason: WALLET_REVERSAL_UNMATCHED };
    }
    if (
      reversesTransactionId !== undefined &&
      !UuidSchema.safeParse(reversesTransactionId).success
    ) {
      return { ok: false, reason: WALLET_REVERSAL_UNMATCHED };
    }

    const creditRow = { ...row, currency: balanceKey(currency) };

    if (bonusSource !== null) {
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
        source: bonusSource,
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

    const request: LedgerRequest = {
      walletId: row.id,
      type,
      direction: 'credit',
      amount,
      currency: creditRow.currency,
      externalRoundId: providerRef?.externalRoundId,
    };
    const move = await txn
      .transaction(async (sp) => {
        if (type === 'bet_reversal' && reversesTransactionId) {
          await this.assertReversible(sp, row.id, reversesTransactionId, {
            amount,
            currency: creditRow.currency,
            providerRef,
          });
        }
        const { row: ledgerRow, replayed } =
          cashTransfer !== null && providerRef
            ? await this.writeTransferCreditRow({
                txn: sp,
                row: creditRow,
                type: cashTransfer,
                amount,
                providerRef,
              })
            : await this.writeLedgerRow(
                sp,
                creditRow,
                type,
                amount,
                'credit',
                providerRef,
                undefined,
                type === 'bet_reversal' ? { reversedTransactionId: reversesTransactionId } : {},
              );
        if (replayed && providerRef) {
          assertReplayMatches(ledgerRow, request, providerRef);
          return { replayedId: ledgerRow.id };
        }
        if (type === 'bet_reversal' && providerRef?.externalRoundId) {
          await this.assertRoundCovers(sp, row.id, creditRow.currency, {
            ...providerRef,
            externalRoundId: providerRef.externalRoundId,
          });
        }

        const realBalance = await readWalletBalanceForUpdate(sp, row.id, balanceKey(currency));

        const settlement =
          this.ports.bonusWagering &&
          providerRef?.externalRoundId &&
          (type === 'win' || type === 'bet_reversal')
            ? await this.ports.bonusWagering.settle(sp, {
                userId,
                currency: balanceKey(currency),
                amount,
                providerName: providerRef.providerName,
                externalRoundId: providerRef.externalRoundId,
                kind: type,
                realBalance,
                ...(closesRound ? { final: true } : {}),
              })
            : { realShare: amount, completed: [] };

        const [credited] = await creditWalletBalance(sp, row.id, currency, settlement.realShare);
        if (!credited) {
          throw new WalletCreditFailedError(row.id, currency);
        }
        await stampBalanceAfter(sp, ledgerRow.id, credited.amount);
        const turnover = this.activeTurnover();
        if (cashTransfer !== null) {
          await turnover?.addCredit(sp, {
            userId,
            kind: cashTransfer,
            sourceRef: ledgerRow.id,
            currency: creditRow.currency,
            amount,
          });
        }
        if (turnover && type === 'bet_reversal' && providerRef) {
          await turnover.reverseStake(sp, {
            userId,
            walletId: row.id,
            currency: creditRow.currency,
            providerName: providerRef.providerName,
            externalRoundId: providerRef.externalRoundId,
            ledgerRowId: ledgerRow.id,
            amount,
            reversesTransactionId,
          });
        }
        if (
          turnover &&
          closesRound &&
          providerRef?.externalRoundId &&
          (type === 'win' || type === 'bet_reversal')
        ) {
          await turnover.settleRound(sp, {
            userId,
            walletId: row.id,
            currency: creditRow.currency,
            providerName: providerRef.providerName,
            externalRoundId: providerRef.externalRoundId,
          });
        }
        if (moneyCompare(settlement.realShare, amount) !== 0) {
          await sp
            .update(walletTransaction)
            .set({ realShare: settlement.realShare })
            .where(eq(walletTransaction.id, ledgerRow.id));
        }
        return {
          ledgerRow,
          realShare: settlement.realShare,
          newBalance: credited.amount,
          completed: settlement.completed,
        };
      })
      .catch((err: unknown) => {
        if (err instanceof ReversalRefused) {
          return { refused: err.reason };
        }
        throw err;
      });
    if ('replayedId' in move) {
      return {
        ok: true,
        moved: false,
        newBalance: await readWalletBalance(txn, row.id, balanceKey(currency)),
        replayedTransactionId: move.replayedId,
      };
    }
    if ('refused' in move) {
      return { ok: false, reason: move.refused };
    }
    const { ledgerRow, realShare, newBalance: creditedBalance, completed } = move;
    const balanceBefore = moneySubtract(creditedBalance, realShare);

    if (type === 'win') {
      await this.auditSignificantAmount(txn, 'wallet.large_win.recorded', userId, ledgerRow, {
        before: balanceBefore,
        after: creditedBalance,
      });
    }
    if (type === 'bet_reversal') {
      await this.audit.recordInTransaction(txn, {
        actorType: 'system',
        action: 'wallet.bet.reversed',
        resourceType: 'wallet_transaction',
        resourceId: ledgerRow.id,
        before: { balance: balanceBefore },
        after: {
          userId,
          amount,
          currency: creditRow.currency,
          credited: realShare,
          balance: creditedBalance,
          providerName: ledgerRow.providerName,
          providerRefId: ledgerRow.providerRefId,
          externalRoundId: ledgerRow.externalRoundId,
        },
      });
    }

    const newBalance = await this.convertAll(txn, creditRow, completed, creditedBalance);
    return {
      ok: true,
      moved: true,
      transactionId: ledgerRow.id,
      newBalance,
      ...(completed.length > 0 ? { completed } : {}),
    };
  }

  async closeRound(
    tx: unknown,
    { userId, currency, providerRef }: WalletCloseRoundArgs,
  ): Promise<{ completed: BonusCompletion[]; newBalance: string | null }> {
    const txn = tx as DrizzleDb;
    const turnover = this.activeTurnover();
    const bonusWagering = this.ports.bonusWagering;
    if (!bonusWagering && !(await turnover?.tracks(txn, userId))) {
      return { completed: [], newBalance: null };
    }
    const row = await this.selectWallet(txn, userId, true);
    if (!row) {
      return { completed: [], newBalance: null };
    }
    const key = balanceKey(currency);
    const realBalance = await readWalletBalanceForUpdate(txn, row.id, key);
    const closed = bonusWagering
      ? await bonusWagering.closeRound(txn, {
          userId,
          currency: key,
          providerName: providerRef.providerName,
          externalRoundId: providerRef.externalRoundId,
          realBalance,
        })
      : undefined;
    const completed = closed?.completed ?? [];
    const newBalance = closed
      ? await this.convertAll(txn, { ...row, currency: key }, completed, realBalance)
      : null;
    await turnover?.settleRound(txn, {
      userId,
      walletId: row.id,
      currency: key,
      providerName: providerRef.providerName,
      externalRoundId: providerRef.externalRoundId,
    });
    return { completed, newBalance };
  }

  async correctionDebit(
    tx: unknown,
    { userId, amount, currency, type, providerRef }: WalletCorrectionDebitArgs,
  ): Promise<WalletCorrectionDebitOutcome> {
    const txn = tx as DrizzleDb;

    if (!WALLET_CORRECTION_DEBIT_TYPES.includes(type)) {
      throw new WalletCorrectionTypeError(type);
    }
    if (!isPositiveMoney(amount)) {
      throw new WalletCommandAmountError('correction debit', amount);
    }
    if (!providerRef.externalRoundId) {
      throw new WalletCorrectionRoundError(providerRef.providerName, providerRef.providerRefId);
    }

    const key = balanceKey(currency);
    const row = await this.selectWallet(txn, userId, true);
    if (!row) {
      throw new WalletCorrectionExceedsRoundError(
        providerRef.providerName,
        providerRef.externalRoundId,
        type,
        amount,
        '0',
      );
    }

    const replayed = await this.findByProviderRef(txn, providerRef);
    if (replayed) {
      if (
        replayed.correctionRequestedAmount === null ||
        replayed.walletId !== row.id ||
        replayed.type !== type ||
        replayed.direction !== 'debit' ||
        replayed.currency !== key ||
        replayed.externalRoundId !== providerRef.externalRoundId ||
        moneyCompare(amount, replayed.correctionRequestedAmount) !== 0
      ) {
        throw new WalletCorrectionRefConflictError(
          providerRef.providerName,
          providerRef.providerRefId,
          replayed.id,
        );
      }
      return {
        moved: false,
        replayedTransactionId: replayed.id,
        collected: replayed.amount,
        shortfall: moneySubtract(amount, replayed.amount),
        newBalance: await readWalletBalance(txn, row.id, key),
      };
    }

    const available = await this.roundCorrectable(txn, row.id, key, type, providerRef);
    if (moneyCompare(amount, available) > 0) {
      throw new WalletCorrectionExceedsRoundError(
        providerRef.providerName,
        providerRef.externalRoundId,
        type,
        amount,
        available,
      );
    }

    const { outcome, ledgerRowId } = await txn.transaction(async (sp) => {
      const taken = await collectWalletBalance(sp, row.id, key, amount);
      const collected = taken?.collected ?? '0';

      const { row: ledgerRow, replayed: raced } = await this.writeLedgerRow(
        sp,
        { id: row.id, currency: key },
        type,
        collected,
        'debit',
        providerRef,
        taken?.balance,
        { correctionRequestedAmount: amount, realShare: collected },
      );
      if (raced) {
        throw new WalletCorrectionRefConflictError(
          providerRef.providerName,
          providerRef.providerRefId,
          ledgerRow.id,
        );
      }

      const shortfall = moneySubtract(amount, collected);
      const result: WalletCorrectionDebitOutcome = taken
        ? {
            moved: true,
            transactionId: ledgerRow.id,
            collected,
            shortfall,
            newBalance: taken.balance,
          }
        : {
            moved: false,
            collected,
            shortfall,
            newBalance: await readWalletBalance(sp, row.id, key),
          };
      return { outcome: result, ledgerRowId: ledgerRow.id };
    });

    await this.audit.recordInTransaction(txn, {
      actorType: 'system',
      action: 'wallet.correction.debited',
      ...(await this.auditSubject(txn, userId, 'wallet_transaction', ledgerRowId)),
      before: { balance: moneyAdd(outcome.newBalance, outcome.collected), currency: key },
      after: {
        transactionId: ledgerRowId,
        balance: outcome.newBalance,
        currency: key,
        userId,
        type,
        requested: amount,
        collected: outcome.collected,
        shortfall: outcome.shortfall,
        providerName: providerRef.providerName,
        providerRefId: providerRef.providerRefId,
        externalRoundId: providerRef.externalRoundId,
      },
    });
    return outcome;
  }

  async placeWithdrawalHold(
    tx: unknown,
    { userId, source, reason }: WalletWithdrawalHoldArgs,
  ): Promise<{ placed: boolean }> {
    const txn = tx as DrizzleDb;
    if (!(await this.selectWallet(txn, userId, true))) {
      throw new WalletHoldWithoutWalletError(userId);
    }
    const bySource = and(
      eq(walletWithdrawalHold.userId, userId),
      eq(walletWithdrawalHold.source, source),
    );
    const [existing] = await txn.select().from(walletWithdrawalHold).where(bySource);
    if (existing?.reason === reason) {
      return { placed: false };
    }
    const [held] = existing
      ? await txn.update(walletWithdrawalHold).set({ reason }).where(bySource).returning()
      : await txn.insert(walletWithdrawalHold).values({ userId, source, reason }).returning();
    if (!held) {
      throw new Error('wallet withdrawal hold: write returned no row');
    }
    await this.audit.recordInTransaction(txn, {
      actorType: 'system',
      action: 'wallet.withdrawal_hold.placed',
      ...(await this.auditSubject(txn, userId, 'wallet_withdrawal_hold', held.id)),
      before: existing ? { userId, source, reason: existing.reason } : null,
      after: { holdId: held.id, userId, source, reason },
    });
    return { placed: !existing };
  }

  async releaseWithdrawalHold(
    tx: unknown,
    { userId, source }: Omit<WalletWithdrawalHoldArgs, 'reason'>,
  ): Promise<{ released: boolean }> {
    const txn = tx as DrizzleDb;
    await this.selectWallet(txn, userId, true);
    const [released] = await txn
      .delete(walletWithdrawalHold)
      .where(and(eq(walletWithdrawalHold.userId, userId), eq(walletWithdrawalHold.source, source)))
      .returning();
    if (!released) {
      return { released: false };
    }
    await this.audit.recordInTransaction(txn, {
      actorType: 'system',
      action: 'wallet.withdrawal_hold.released',
      ...(await this.auditSubject(txn, userId, 'wallet_withdrawal_hold', released.id)),
      before: { holdId: released.id, userId, source, reason: released.reason },
      after: null,
    });
    return { released: true };
  }

  private async auditSubject(
    txn: DrizzleDb,
    userId: Uuid,
    resourceType: string,
    resourceId: Uuid,
  ): Promise<{ resourceType: string; resourceId: string }> {
    const playerId = await this.ports.identityReader?.getPlayerIdByUserId(userId, txn);
    return playerId
      ? { resourceType: 'player', resourceId: playerId }
      : { resourceType, resourceId };
  }

  private async assertReversible(
    txn: DrizzleDb,
    walletId: Wallet['id'],
    betId: WalletTransaction['id'],
    reversal: { amount: string; currency: string; providerRef: WalletProviderRef | undefined },
  ): Promise<void> {
    const t = walletTransaction;
    const { providerRef } = reversal;
    const [bet] = await txn
      .select({
        amount: t.amount,
        currency: t.currency,
        providerName: t.providerName,
        externalRoundId: t.externalRoundId,
      })
      .from(t)
      .where(
        and(
          eq(t.id, betId),
          eq(t.walletId, walletId),
          eq(t.type, 'bet'),
          eq(t.direction, 'debit'),
          eq(t.status, 'completed'),
        ),
      );
    const matches =
      bet &&
      bet.providerName === (providerRef?.providerName ?? null) &&
      bet.externalRoundId === (providerRef?.externalRoundId ?? null) &&
      balanceKey(bet.currency) === reversal.currency &&
      moneyCompare(reversal.amount, bet.amount) <= 0;
    if (!matches) {
      throw new ReversalRefused(WALLET_REVERSAL_UNMATCHED);
    }
    const [previous] = await txn
      .select({ providerName: t.providerName, providerRefId: t.providerRefId })
      .from(t)
      .where(eq(t.reversedTransactionId, betId));
    const retry =
      previous?.providerName === providerRef?.providerName &&
      previous?.providerRefId === providerRef?.providerRefId;
    if (previous && !retry) {
      throw new ReversalRefused(WALLET_BET_ALREADY_REVERSED);
    }
  }

  private async assertRoundCovers(
    txn: DrizzleDb,
    walletId: Wallet['id'],
    currency: string,
    providerRef: WalletProviderRef & { externalRoundId: string },
  ): Promise<void> {
    const t = walletTransaction;
    const [round] = await txn
      .select({
        staked: sql<string>`coalesce(sum(${t.amount}) filter (where ${t.type} = 'bet' and ${t.direction} = 'debit'), 0)`,
        reversed: sql<string>`coalesce(sum(${t.amount}) filter (where ${t.type} = 'bet_reversal' and ${t.direction} = 'credit'), 0)`,
      })
      .from(t)
      .where(
        and(
          eq(t.walletId, walletId),
          eq(t.providerName, providerRef.providerName),
          eq(t.externalRoundId, providerRef.externalRoundId),
          eq(t.currency, currency),
          eq(t.status, 'completed'),
        ),
      );
    const staked = round?.staked ?? '0';
    if (!isPositiveMoney(staked)) {
      throw new ReversalRefused(WALLET_REVERSAL_UNMATCHED);
    }
    if (moneyCompare(round?.reversed ?? '0', staked) > 0) {
      throw new ReversalRefused(WALLET_BET_ALREADY_REVERSED);
    }
  }

  private async roundCorrectable(
    txn: DrizzleDb,
    walletId: Wallet['id'],
    currency: string,
    type: WalletCorrectionDebitType,
    providerRef: WalletProviderRef & { externalRoundId: string },
  ): Promise<string> {
    const paid = type === 'win_reversal' ? 'win' : 'bet_reversal';
    const t = walletTransaction;
    const [round] = await txn
      .select({
        paid: sql<string>`coalesce(sum(coalesce(${t.realShare}, ${t.amount})) filter (where ${t.type} = ${paid} and ${t.direction} = 'credit'), 0)`,
        taken: sql<string>`coalesce(sum(${t.amount}) filter (where ${t.type} = ${type} and ${t.direction} = 'debit' and ${isNotNull(t.correctionRequestedAmount)}), 0)`,
      })
      .from(t)
      .where(
        and(
          eq(t.walletId, walletId),
          eq(t.providerName, providerRef.providerName),
          eq(t.externalRoundId, providerRef.externalRoundId),
          eq(t.currency, currency),
          eq(t.status, 'completed'),
        ),
      );
    return moneySubtract(round?.paid ?? '0', round?.taken ?? '0');
  }

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
