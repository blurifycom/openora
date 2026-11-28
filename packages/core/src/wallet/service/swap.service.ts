import {
  assertRateLimit,
  createDomainError,
  createLogger,
  findOneOrThrow,
  isPositiveMoney,
  makeConflictError,
  moneyEquals,
  type DrizzleService,
  type EventBus,
  type DrizzleTx,
} from '@openora/core/server';
import {
  makeRateLimitKey,
  RATE_LIMIT_KEYS,
  type AuditWritePort,
  type BonusFundLockCommands,
  type PlatformConfig,
  type RateLimitKey,
  type RateLimiterAdapter,
  type SwapAdapter,
  type SwapExecution,
  type SwapQuote,
  type SwapWebhookEvent,
  type User,
} from '@openora/core/contracts';
import { and, eq } from 'drizzle-orm';
import * as z from 'zod';
import { wallet, walletTransaction, type Wallet, type WalletTransaction } from '../schema/index.js';
import {
  InsufficientBalanceError,
  IdempotencyKeyReuseError,
  WalletNotFoundError,
  balanceKey,
  creditWalletBalance,
  railFor,
  debitWalletBalance,
  readWalletBalance,
  stampBalanceAfter,
} from './wallet.service.js';
import type { TurnoverService } from './turnover.service.js';

const logger = createLogger('wallet-swap');

const SWAP_RATE_LIMIT = { limit: 30, windowMs: 60 * 1000 };

export const SwapUnavailableError = makeConflictError(
  'SwapUnavailableError',
  'no swap vendor is configured',
);

export const SwapPairUnsupportedError = createDomainError<[from: string, to: string]>(
  'SwapPairUnsupportedError',
  (from, to) => `swap pair ${from}->${to} is not supported`,
);

const SwapFillAmountMissingError = createDomainError<[externalId: string]>(
  'SwapFillAmountMissingError',
  (externalId) => `swap ${externalId} completed without a fill amount`,
);

const SwapLegMetadataSchema = z.object({
  toCurrency: z.string(),
  quoteId: z.string().optional(),
});

export type SwapResult = {
  transactionId: WalletTransaction['id'];
  status: WalletTransaction['status'];
  toAmount: string | null;
};

export class SwapService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly adapter: SwapAdapter;
  private readonly audit: AuditWritePort;
  private readonly platformConfig?: PlatformConfig;
  private readonly limiter?: RateLimiterAdapter<RateLimitKey>;
  private readonly bonusFundLocks?: BonusFundLockCommands;
  private readonly turnover?: TurnoverService;

  constructor(deps: {
    drizzle: DrizzleService;
    events: EventBus;
    adapter: SwapAdapter;
    audit: AuditWritePort;
    platformConfig?: PlatformConfig;
    limiter?: RateLimiterAdapter<RateLimitKey>;
    bonusFundLocks?: BonusFundLockCommands;
    turnover?: TurnoverService;
  }) {
    this.drizzle = deps.drizzle;
    this.events = deps.events;
    this.adapter = deps.adapter;
    this.audit = deps.audit;
    this.platformConfig = deps.platformConfig;
    this.limiter = deps.limiter;
    this.bonusFundLocks = deps.bonusFundLocks;
    this.turnover = deps.turnover;
  }

  async quote({
    userId,
    ...input
  }: {
    userId: User['id'];
    fromCurrency: string;
    toCurrency: string;
    fromAmount: string;
  }): Promise<SwapQuote> {
    await this.rateLimit(userId);
    this.assertPair(input.fromCurrency, input.toCurrency);
    const quote = await this.adapter.getQuote({ ...input, userId });
    if (!quote) {
      throw new SwapPairUnsupportedError(input.fromCurrency, input.toCurrency);
    }
    return quote;
  }

  async swap({
    userId,
    fromCurrency,
    toCurrency,
    fromAmount,
    quoteId,
    idempotencyKey,
  }: {
    userId: User['id'];
    fromCurrency: string;
    toCurrency: string;
    fromAmount: string;
    quoteId?: SwapQuote['quoteId'];
    idempotencyKey: NonNullable<WalletTransaction['idempotencyKey']>;
  }): Promise<SwapResult> {
    await this.rateLimit(userId);
    this.assertPair(fromCurrency, toCurrency);

    const { row, replayed } = await this.drizzle.db.transaction(async (txn) => {
      const current = findOneOrThrow(
        await txn.select().from(wallet).where(eq(wallet.userId, userId)).for('update'),
        new WalletNotFoundError(userId),
      );

      const existing = await this.findByIdempotencyKey(txn, current.id, idempotencyKey);
      if (existing) {
        this.assertReplayMatches(existing, fromAmount, fromCurrency);
        return { row: existing, replayed: true };
      }

      const [inserted] = await txn
        .insert(walletTransaction)
        .values({
          walletId: current.id,
          type: 'swap_out',
          amount: fromAmount,
          currency: balanceKey(fromCurrency),
          status: 'processing',
          direction: 'debit',
          rail: railFor(fromCurrency, this.platformConfig?.wallet?.cryptoCurrencies),
          idempotencyKey,
          metadata: JSON.stringify({ toCurrency: balanceKey(toCurrency), quoteId }),
        })
        .onConflictDoNothing()
        .returning();

      if (!inserted) {
        const winner = findOneOrThrow(
          await this.findByIdempotencyKeyRows(txn, current.id, idempotencyKey),
          new IdempotencyKeyReuseError(),
        );
        this.assertReplayMatches(winner, fromAmount, fromCurrency);
        return { row: winner, replayed: true };
      }

      const [debited] = await debitWalletBalance(txn, current.id, fromCurrency, fromAmount);
      if (!debited) {
        throw new InsufficientBalanceError(
          await readWalletBalance(txn, current.id, fromCurrency),
          fromAmount,
        );
      }
      await stampBalanceAfter(txn, inserted.id, debited.amount);
      await this.bonusFundLocks?.onOutflow(txn, {
        userId,
        currency: balanceKey(fromCurrency),
        amount: fromAmount,
        balanceAfter: debited.amount,
        outflow: 'swap',
      });

      return { row: inserted, replayed: false };
    });

    if (replayed) {
      return this.toResult(row);
    }

    let execution;
    try {
      execution = await this.adapter.execute({
        userId,
        quoteId,
        fromCurrency,
        toCurrency,
        fromAmount,
        idempotencyKey: row.id,
      });
    } catch (err) {
      await this.refund(row);
      throw err;
    }

    if (execution.status === 'failed') {
      await this.refund(row, execution.externalId);
      return { transactionId: row.id, status: 'failed', toAmount: null };
    }

    if (execution.status === 'processing') {
      await this.drizzle.db
        .update(walletTransaction)
        .set({ providerRefId: execution.externalId })
        .where(eq(walletTransaction.id, row.id));
      return { transactionId: row.id, status: 'processing', toAmount: null };
    }

    return this.settle(row, execution.externalId, execution.toAmount);
  }

  async reconcileSwapStatus(event: SwapWebhookEvent): Promise<void> {
    const [row] = await this.drizzle.db
      .select()
      .from(walletTransaction)
      .where(eq(walletTransaction.providerRefId, event.externalId));
    if (!row || row.type !== 'swap_out') {
      logger.warn(
        { externalId: event.externalId },
        'swap webhook: no matching swap for externalId',
      );
      return;
    }
    if (row.status !== 'processing') {
      return;
    }
    if (event.status === 'completed') {
      await this.settle(row, event.externalId, event.toAmount);
      return;
    }
    if (event.status === 'failed') {
      await this.refund(row, event.externalId);
    }
  }

  private async settle(
    out: WalletTransaction,
    externalId: SwapExecution['externalId'],
    toAmount: string | undefined,
  ): Promise<SwapResult> {
    if (toAmount === undefined || !isPositiveMoney(toAmount)) {
      await this.audit.record({
        actorType: 'system',
        action: 'wallet.swap.fill_rejected',
        resourceType: 'wallet_transaction',
        resourceId: out.id,
        after: { externalId, toAmount: toAmount ?? null },
      });
      throw new SwapFillAmountMissingError(externalId);
    }
    const toCurrency = this.toCurrencyOf(out);

    await this.drizzle.db.transaction(async (txn) => {
      const flipped = await txn
        .update(walletTransaction)
        .set({ status: 'completed', providerRefId: externalId })
        .where(and(eq(walletTransaction.id, out.id), eq(walletTransaction.status, 'processing')))
        .returning({ id: walletTransaction.id });
      if (flipped.length === 0) {
        return;
      }

      const userId = await this.userIdForWallet(txn, out.walletId);
      const [credited] = await creditWalletBalance(txn, out.walletId, toCurrency, toAmount);
      const [inLeg] = await txn
        .insert(walletTransaction)
        .values({
          walletId: out.walletId,
          type: 'swap_in',
          amount: toAmount,
          currency: balanceKey(toCurrency),
          balanceAfter: credited?.amount,
          status: 'completed',
          direction: 'credit',
          rail: railFor(toCurrency, this.platformConfig?.wallet?.cryptoCurrencies),
          metadata: JSON.stringify({ swapTransactionId: out.id, externalId }),
        })
        .returning({ id: walletTransaction.id });
      if (!inLeg) {
        throw new Error(`wallet swap: in-leg of ${out.id} was not written`);
      }
      await this.turnover?.addCredit(txn, {
        userId,
        kind: 'swap_in',
        sourceRef: inLeg.id,
        currency: balanceKey(toCurrency),
        amount: toAmount,
      });
      await this.audit.recordInTransaction(txn, {
        actorType: 'system',
        action: 'wallet.swap.completed',
        resourceType: 'wallet_transaction',
        resourceId: out.id,
        after: {
          userId,
          fromCurrency: out.currency,
          fromAmount: out.amount,
          toCurrency: balanceKey(toCurrency),
          toAmount,
          externalId,
        },
      });
      await this.events.emitInTransaction(txn, 'wallet.swap.completed', {
        userId,
        transactionId: out.id,
        fromCurrency: out.currency,
        fromAmount: out.amount,
        toCurrency: balanceKey(toCurrency),
        toAmount,
      });
    });

    return { transactionId: out.id, status: 'completed', toAmount };
  }

  private async refund(
    out: WalletTransaction,
    externalId?: SwapExecution['externalId'],
  ): Promise<void> {
    await this.drizzle.db.transaction(async (txn) => {
      const flipped = await txn
        .update(walletTransaction)
        .set({ status: 'failed', ...(externalId ? { providerRefId: externalId } : {}) })
        .where(and(eq(walletTransaction.id, out.id), eq(walletTransaction.status, 'processing')))
        .returning({ id: walletTransaction.id });
      if (flipped.length === 0) {
        return;
      }
      const userId = await this.userIdForWallet(txn, out.walletId);
      await creditWalletBalance(txn, out.walletId, out.currency, out.amount);
      await this.audit.recordInTransaction(txn, {
        actorType: 'system',
        action: 'wallet.swap.refunded',
        resourceType: 'wallet_transaction',
        resourceId: out.id,
        after: {
          userId,
          currency: out.currency,
          amount: out.amount,
          externalId: externalId ?? null,
        },
      });
    });
  }

  private assertPair(fromCurrency: string, toCurrency: string): void {
    if (balanceKey(fromCurrency) === balanceKey(toCurrency)) {
      throw new SwapPairUnsupportedError(fromCurrency, toCurrency);
    }
    if (this.adapter.supportsPair && !this.adapter.supportsPair(fromCurrency, toCurrency)) {
      throw new SwapPairUnsupportedError(fromCurrency, toCurrency);
    }
  }

  private toCurrencyOf(out: WalletTransaction): string {
    const parsed = SwapLegMetadataSchema.safeParse(
      out.metadata ? (JSON.parse(out.metadata) as unknown) : null,
    );
    if (!parsed.success) {
      throw new Error(`wallet swap: transaction ${out.id} has no target currency recorded`);
    }
    return parsed.data.toCurrency;
  }

  private toResult(row: WalletTransaction): SwapResult {
    return { transactionId: row.id, status: row.status, toAmount: null };
  }

  private assertReplayMatches(
    existing: WalletTransaction,
    fromAmount: string,
    fromCurrency: string,
  ): void {
    if (
      existing.type !== 'swap_out' ||
      !moneyEquals(existing.amount, fromAmount) ||
      existing.currency !== balanceKey(fromCurrency)
    ) {
      throw new IdempotencyKeyReuseError();
    }
  }

  private async findByIdempotencyKey(
    txn: DrizzleTx,
    walletId: Wallet['id'],
    idempotencyKey: NonNullable<WalletTransaction['idempotencyKey']>,
  ): Promise<WalletTransaction | undefined> {
    const [row] = await this.findByIdempotencyKeyRows(txn, walletId, idempotencyKey);
    return row;
  }

  private findByIdempotencyKeyRows(
    txn: DrizzleTx,
    walletId: Wallet['id'],
    idempotencyKey: NonNullable<WalletTransaction['idempotencyKey']>,
  ) {
    return txn
      .select()
      .from(walletTransaction)
      .where(
        and(
          eq(walletTransaction.walletId, walletId),
          eq(walletTransaction.idempotencyKey, idempotencyKey),
        ),
      );
  }

  private async userIdForWallet(txn: DrizzleTx, walletId: Wallet['id']): Promise<User['id']> {
    const [row] = await txn
      .select({ userId: wallet.userId })
      .from(wallet)
      .where(eq(wallet.id, walletId));
    if (!row) {
      throw new WalletNotFoundError(walletId);
    }
    return row.userId;
  }

  private rateLimit(userId: User['id']) {
    return this.limiter
      ? assertRateLimit(
          this.limiter,
          makeRateLimitKey(RATE_LIMIT_KEYS.WALLET_MUTATION, userId),
          SWAP_RATE_LIMIT,
        )
      : Promise.resolve();
  }
}
