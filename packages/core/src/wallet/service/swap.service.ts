import {
  assertRateLimit,
  createDomainError,
  createLogger,
  findOneOrThrow,
  makeConflictError,
  moneyCompare,
  moneyEquals,
  type DrizzleService,
  type EventBus,
  type DrizzleTx,
} from '@openora/core/server';
import {
  makeRateLimitKey,
  MoneyAmountSchema,
  RATE_LIMIT_KEYS,
  type AuditWritePort,
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
  BonusRolloverLockedError,
  InsufficientBalanceError,
  IdempotencyKeyReuseError,
  WalletNotFoundError,
  balanceKey,
  creditWalletBalance,
  debitWithdrawableBalance,
  railFor,
  readLockedBonusAmount,
  readWalletBalance,
} from './wallet.service.js';

const logger = createLogger('wallet-swap');

// Same policy as the other money mutations - a swap is one, and it also costs a vendor call.
const SWAP_RATE_LIMIT = { limit: 30, windowMs: 60 * 1000 };

export const SwapUnavailableError = makeConflictError(
  'SwapUnavailableError',
  'no swap vendor is configured',
);

export const SwapPairUnsupportedError = createDomainError<[from: string, to: string]>(
  'SwapPairUnsupportedError',
  (from, to) => `swap pair ${from}->${to} is not supported`,
);

// The vendor reported a fill but not what it filled. Nothing may be credited off a
// missing number, so the swap stays `processing` for the webhook (or an operator) to
// finish rather than guessing at the quoted amount.
export const SwapFillAmountMissingError = createDomainError<[externalId: string]>(
  'SwapFillAmountMissingError',
  (externalId) => `swap ${externalId} completed without a fill amount`,
);

/**
 * The out-leg carries what the in-leg will need once the vendor settles - the ledger has
 * no column for a swap's other side, and a webhook arriving hours later has nothing but
 * this row to work from.
 */
const SwapLegMetadataSchema = z.object({
  toCurrency: z.string(),
  quoteId: z.string().optional(),
});

// A vendor amount is untrusted input: a malformed string must read as "no fill", never
// reach the ledger, and never be compared as a float.
function isPositiveMoney(value: string): boolean {
  return MoneyAmountSchema.safeParse(value).success && moneyCompare(value, '0') > 0;
}

export type SwapResult = {
  transactionId: WalletTransaction['id'];
  status: WalletTransaction['status'];
  /** What was credited, once the vendor filled. Null while the swap is still `processing`. */
  toAmount: string | null;
};

/**
 * Currency swaps between a player's own balances, booked as two ledger legs: a `swap_out`
 * debit written (and the funds held) before the vendor is called, and a `swap_in` credit
 * written only against a number the vendor actually filled. The vendor call never runs
 * inside a transaction - the hold commits first, exactly like a withdrawal, so a slow or
 * hanging desk cannot pin a row lock.
 *
 * A vendor that fills asynchronously leaves the out-leg `processing` until its webhook
 * lands (`reconcileSwapStatus`). Nothing sweeps those: the wallet reconciliation cycle
 * only looks at withdrawals, so a vendor that never calls back leaves the player's funds
 * held. Add a poll over `getSwapStatus` when a real desk with async fills is bound.
 */
export class SwapService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly adapter: SwapAdapter;
  private readonly audit: AuditWritePort;
  private readonly platformConfig?: PlatformConfig;
  private readonly limiter?: RateLimiterAdapter<RateLimitKey>;

  constructor(deps: {
    drizzle: DrizzleService;
    events: EventBus;
    adapter: SwapAdapter;
    audit: AuditWritePort;
    platformConfig?: PlatformConfig;
    limiter?: RateLimiterAdapter<RateLimitKey>;
  }) {
    this.drizzle = deps.drizzle;
    this.events = deps.events;
    this.adapter = deps.adapter;
    this.audit = deps.audit;
    this.platformConfig = deps.platformConfig;
    this.limiter = deps.limiter;
  }

  /**
   * Player-scoped even though a price is not player-specific: a quote is a vendor call the
   * desk bills for, so it is behind the session and the same per-player throttle the swap
   * itself takes rather than an open pricing endpoint.
   */
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

    // Phase one: hold the player's funds and commit. A `processing` out-leg is the record
    // that money left the balance, so a crash before the vendor answers is visible rather
    // than a silent gap.
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

      // Lost the race on the (walletId, idempotencyKey) unique index: the winner's row is
      // the swap, and this request is a replay of it.
      if (!inserted) {
        const winner = findOneOrThrow(
          await this.findByIdempotencyKeyRows(txn, current.id, idempotencyKey),
          new IdempotencyKeyReuseError(),
        );
        this.assertReplayMatches(winner, fromAmount, fromCurrency);
        return { row: winner, replayed: true };
      }

      // Bonus-locked funds are not swappable, same as they are not withdrawable. The two
      // refusals are told apart the way `withdraw` does it: a balance that covers the amount
      // but a debit that did not land means rollover held it, and telling the player
      // "insufficient balance" against a balance they can see would be a lie.
      const debited = await debitWithdrawableBalance(txn, current.id, fromCurrency, fromAmount);
      if (debited.length !== 1) {
        const [available, locked] = await Promise.all([
          readWalletBalance(txn, current.id, fromCurrency),
          readLockedBonusAmount(txn, current.id, fromCurrency),
        ]);
        if (moneyCompare(available, fromAmount) < 0) {
          throw new InsufficientBalanceError(available, fromAmount);
        }
        throw new BonusRolloverLockedError(locked);
      }

      return { row: inserted, replayed: false };
    });

    if (replayed) {
      return this.toResult(row);
    }

    // Phase two, outside the transaction. The out-leg's id is the idempotency key the
    // vendor must dedupe on, so a retried execute returns the original trade.
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
      // No trade the vendor will honour - return the held funds before rethrowing.
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

  /** Vendor-driven settlement of a swap its `execute` left `processing`. */
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

  // Credits the in-leg against the filled amount and closes the out-leg, in one
  // transaction. The `status = 'processing'` guard is the payout guard: an execute
  // response and a webhook racing on the same fill credit the player once.
  private async settle(
    out: WalletTransaction,
    externalId: SwapExecution['externalId'],
    toAmount: string | undefined,
  ): Promise<SwapResult> {
    if (toAmount === undefined || !isPositiveMoney(toAmount)) {
      throw new SwapFillAmountMissingError(externalId);
    }
    const toCurrency = this.toCurrencyOf(out);
    const userId = await this.userIdForWallet(out.walletId);

    const settled = await this.drizzle.db.transaction(async (txn) => {
      const flipped = await txn
        .update(walletTransaction)
        .set({ status: 'completed', providerRefId: externalId })
        .where(and(eq(walletTransaction.id, out.id), eq(walletTransaction.status, 'processing')))
        .returning({ id: walletTransaction.id });
      if (flipped.length === 0) {
        return false;
      }

      await creditWalletBalance(txn, out.walletId, toCurrency, toAmount);
      await txn.insert(walletTransaction).values({
        walletId: out.walletId,
        type: 'swap_in',
        amount: toAmount,
        currency: balanceKey(toCurrency),
        status: 'completed',
        direction: 'credit',
        rail: railFor(toCurrency, this.platformConfig?.wallet?.cryptoCurrencies),
        // Not providerRefId: that column is globally unique, and the vendor's id already
        // belongs to the out-leg. The in-leg points back at its own pair instead.
        metadata: JSON.stringify({ swapTransactionId: out.id, externalId }),
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
      return true;
    });

    if (settled) {
      this.events.emit('wallet.swap.completed', {
        userId,
        transactionId: out.id,
        fromCurrency: out.currency,
        fromAmount: out.amount,
        toCurrency: balanceKey(toCurrency),
        toAmount,
      });
    }

    return { transactionId: out.id, status: 'completed', toAmount };
  }

  // Returns the held funds and closes the out-leg as `failed`. Guarded on `processing`
  // so a refund can never run twice for one hold.
  private async refund(
    out: WalletTransaction,
    externalId?: SwapExecution['externalId'],
  ): Promise<void> {
    const userId = await this.userIdForWallet(out.walletId);
    await this.drizzle.db.transaction(async (txn) => {
      const flipped = await txn
        .update(walletTransaction)
        .set({ status: 'failed', ...(externalId ? { providerRefId: externalId } : {}) })
        .where(and(eq(walletTransaction.id, out.id), eq(walletTransaction.status, 'processing')))
        .returning({ id: walletTransaction.id });
      if (flipped.length === 0) {
        return;
      }
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

  // Written by this service one insert earlier, so a malformed value is a bug here, not
  // untrusted input - but it still comes back from the DB as a string, so it is parsed
  // rather than cast.
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

  private async userIdForWallet(walletId: Wallet['id']): Promise<User['id']> {
    const [row] = await this.drizzle.db
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
