import {
  type EventBus,
  type DrizzleDb,
  type DrizzleTx,
  makeNotFoundError,
  makeConflictError,
  createDomainError,
  DrizzleService,
  findOneOrThrow,
  pageToOffset,
  withAdvisoryXactLock,
  assertRateLimit,
  createLogger,
  moneyToNumber,
} from '@openora/core/server';
import {
  normalizeKycStatus,
  type PaymentAdapter,
  type PaymentWebhookEvent,
  type AdminUserDirectory,
  type PlatformConfig,
  type KycStatus,
  type RateLimiterAdapter,
  type RateLimitKey,
  type WalletRail,
  type PlayerTags,
  type AuditWritePort,
  type TagEvaluationCommands,
  type TagKey,
  type User,
  type ClientMeta,
  type PaginationOptions,
} from '@openora/core/contracts';
import { eq, asc, desc, sql, and, gte, lte, count, inArray } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import {
  wallet,
  walletTransaction,
  autoWithdrawalRule,
  walletDepositAddress,
  type Wallet,
  type WalletTransaction,
  type AutoWithdrawalRule as AutoWithdrawalRuleRow,
} from '../schema/index.js';
import type {
  TransactionResult,
  WithdrawalQueueItem,
  WithdrawalQueueFilter,
  AutoWithdrawalRule,
  WalletTransactionSortBy,
} from '../contract/index.js';

const logger = createLogger('wallet');

export const WalletNotFoundError = makeNotFoundError('Wallet');
export const WithdrawalNotFoundError = makeNotFoundError('Withdrawal');

export const InsufficientBalanceError = createDomainError<[available: string, requested: string]>(
  'InsufficientBalanceError',
  (available, requested) => `Insufficient balance: available ${available}, requested ${requested}`,
);

export const WithdrawalNotPendingError = makeConflictError(
  'WithdrawalNotPendingError',
  'Withdrawal is not pending and cannot be reviewed',
);

export const KycRequiredError = makeConflictError(
  'KycRequiredError',
  'KYC verification required before withdrawal',
);

export const IdempotencyKeyReuseError = makeConflictError(
  'IdempotencyKeyReuseError',
  'Idempotency key was already used with a different amount',
);

export const DepositAddressUnsupportedError = makeConflictError(
  'DepositAddressUnsupportedError',
  'The bound payment adapter does not support address-based deposits',
);

export const DestinationAddressRequiredError = makeConflictError(
  'DestinationAddressRequiredError',
  'A destination address is required for a crypto-rail withdrawal',
);

const KYC_PASS_STATUSES: ReadonlySet<KycStatus> = new Set(['approved', 'manually_overridden']);

export const CurrencyMismatchError = createDomainError(
  'CurrencyMismatchError',
  (requested, walletCurrency) =>
    `Currency mismatch: requested ${requested}, wallet holds ${walletCurrency}`,
);

// Crypto currencies settle on the crypto rail (Fireblocks); everything else on the
// fiat rail (a PSP). The concrete provider is recorded per transaction, not here.
// Overridable per-operator via `platformConfig.wallet.cryptoCurrencies` - see `railFor`.
const DEFAULT_CRYPTO_CURRENCIES = new Set(['BTC', 'ETH', 'USDT', 'USDC']);

// Per-user throttle on money mutations - guards a runaway/misbehaving client, not
// fraud (idempotency + the ledger guard cover correctness). An overlay rebinds
// RATE_LIMITER to change the backend, not this policy.
const WALLET_MUTATION_RATE_LIMIT = { limit: 30, windowMs: 60 * 1000 };

export function railFor(currency: string, cryptoCurrencies?: readonly string[]): WalletRail {
  const set = cryptoCurrencies
    ? new Set(cryptoCurrencies.map((c) => c.toUpperCase()))
    : DEFAULT_CRYPTO_CURRENCIES;
  return set.has(currency.toUpperCase()) ? 'crypto' : 'fiat';
}

// Namespace the key per operation so the same raw key on a deposit then a withdraw can't
// collide on the (walletId, idempotencyKey) unique index. The column is a uuid, so a string
// prefix won't parse - hash namespace + key into a stable pseudo-uuid instead.
const DEPOSIT_IDEMPOTENCY_NAMESPACE = 'deposit';
const WITHDRAW_IDEMPOTENCY_NAMESPACE = 'withdraw';

function namespacedIdempotencyKey(namespace: string, rawKey: string): string {
  const hex = createHash('sha256').update(`${namespace}:${rawKey}`).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

// ponytail: a flat, currency-agnostic threshold - a starter heuristic for the review
// queue, not a compliance risk engine. Revisit with a real risk service if/when one exists.
// moneyToNumber is the sanctioned JS conversion point for this heuristic comparison only.
const LARGE_WITHDRAWAL_THRESHOLD = '5000';

// ponytail: >=3 withdrawals in a 24h window flags velocity; a flat count, not a per-tier rule.
const HIGH_FREQUENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const HIGH_FREQUENCY_MIN_COUNT = 3;

const DAILY_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

// Also the marker the cumulative-cap query reads back to identify auto-approved payouts - keep write and read in lockstep.
const AUTO_APPROVED_REASON = 'auto-approved';

type AutoApprovalDecision = {
  threshold: string;
  thresholdSource: 'per-player' | 'global';
  kycStatus: KycStatus;
  riskTagsEvaluated: TagKey[];
  dailyCapAmount: string | null;
  dailyCapCount: number | null;
  cumulativeAmountUsed: string;
  cumulativeCountUsed: number;
};

// The pre-lock portion of the decision, resolvable without the advisory-locked cap read.
type AutoApprovalGates = Pick<
  AutoApprovalDecision,
  'threshold' | 'thresholdSource' | 'kycStatus' | 'riskTagsEvaluated'
>;

function toAutoWithdrawalRuleDto(row: AutoWithdrawalRuleRow): AutoWithdrawalRule {
  return {
    id: row.id,
    userId: row.userId,
    threshold: row.threshold,
    reason: row.reason,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// The concrete settlement provider recorded per transaction: the crypto rail settles
// through Fireblocks, the fiat rail through a PSP.
function providerNameFor(rail: WalletRail | null): string {
  return rail === 'crypto' ? 'fireblocks' : 'psp';
}

export type WalletServiceDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  payment: PaymentAdapter;
  directory?: AdminUserDirectory;
  platformConfig?: PlatformConfig;
  limiter?: RateLimiterAdapter<RateLimitKey>;
  // Optional: bound by the tag module. If risk-flag exclusions are configured but this is absent, auto-approval fails closed.
  riskTags?: PlayerTags;
  // Optional: bound by the tag module. Not hard-`dependsOn`-wired (would cycle - tag
  // depends on wallet's WALLET_READER), resolved lazily like riskTags/PLAYER_TAGS above.
  // Absent = withdrawal_review evaluation is simply skipped (matches the pre-existing
  // async-event-only behavior when the tag module isn't loaded).
  tagEvaluationCommands?: TagEvaluationCommands;
  // Required: the auto-approval audit trail is a regulatory invariant, so wallet hard-depends on audit.
  audit: AuditWritePort;
};

/**
 * Owns all wallet balance mutations and the withdrawal review/auto-approval
 * pipeline. Every balance change is a transactional, idempotent-keyed ledger
 * write (never a bare balance update) - `amount` is always a decimal string,
 * mutated via SQL numeric arithmetic, never a JS float. Domain events emit only
 * AFTER the owning transaction commits, and only for the non-replay branch of
 * an idempotent call.
 */
export class WalletService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly payment: PaymentAdapter;
  private readonly directory?: AdminUserDirectory;
  private readonly platformConfig?: PlatformConfig;
  private readonly limiter?: RateLimiterAdapter<RateLimitKey>;
  private readonly riskTags?: PlayerTags;
  private readonly tagEvaluationCommands?: TagEvaluationCommands;
  private readonly audit: AuditWritePort;

  constructor({
    drizzle,
    events,
    payment,
    directory,
    platformConfig,
    limiter,
    riskTags,
    tagEvaluationCommands,
    audit,
  }: WalletServiceDeps) {
    this.drizzle = drizzle;
    this.events = events;
    this.payment = payment;
    this.directory = directory;
    this.platformConfig = platformConfig;
    this.limiter = limiter;
    this.riskTags = riskTags;
    this.tagEvaluationCommands = tagEvaluationCommands;
    this.audit = audit;
  }

  private resolveRail(currency: string): WalletRail {
    return railFor(currency, this.platformConfig?.wallet?.cryptoCurrencies);
  }

  private rateLimit(userId: User['id']) {
    return this.limiter
      ? assertRateLimit(this.limiter, `wallet-mutation:${userId}`, WALLET_MUTATION_RATE_LIMIT)
      : Promise.resolve();
  }

  private async assertKycForWithdrawal(userId: User['id']) {
    if (!this.platformConfig?.kyc?.gateWithdrawals) {
      return;
    }
    const status = await this.autoApprovalKycStatus(userId);
    if (!status || !KYC_PASS_STATUSES.has(normalizeKycStatus(status))) {
      throw new KycRequiredError();
    }
  }

  async getBalance(userId: User['id']) {
    const [record] = await this.drizzle.db.select().from(wallet).where(eq(wallet.userId, userId));

    if (!record) {
      return { balance: '0', currency: 'USD' };
    }

    return {
      balance: record.balance,
      currency: record.currency,
    };
  }

  /**
   * `idempotencyKey` (when supplied) makes a retried deposit a no-op: a replay
   * returns the original committed result WITHOUT calling the PSP again or
   * crediting the balance twice, and rejects if the same key is reused with a
   * different amount/currency (`IdempotencyKeyReuseError`). A GENUINE
   * concurrent race (two first-attempts, same key, landing at once) can both
   * reach the PSP, but the ledger insert's unique-index conflict still
   * guarantees only one balance credit - the loser's write becomes a replay
   * read of the winner's row.
   */
  async deposit({
    userId,
    amount,
    currency,
    provider,
    idempotencyKey,
  }: {
    userId: User['id'];
    amount: string;
    currency: string;
    provider?: string;
    idempotencyKey?: string;
  }): Promise<TransactionResult> {
    await this.rateLimit(userId);

    // Short-circuit a replay BEFORE the PSP call - the common retry case (client
    // resends after a timeout) must not re-charge. A genuine concurrent race (two
    // first-attempts for the same key landing here at once) can still both reach the
    // PSP; the ledger write itself is guaranteed not to double-credit (see below).
    let preResolvedWallet: Wallet | undefined;
    if (idempotencyKey) {
      const found = await this.findDepositReplay({ userId, idempotencyKey, amount, currency });
      if (found.replay) {
        return found.replay;
      }
      preResolvedWallet = found.walletRecord;
    }

    const psp = await this.payment.processDeposit(amount, currency, { userId, provider });

    const { transactionId, replayed } = await this.drizzle.db.transaction(async (txn) => {
      let walletRecord = preResolvedWallet;
      if (!walletRecord) {
        [walletRecord] = await txn.select().from(wallet).where(eq(wallet.userId, userId));
      }
      if (!walletRecord) {
        walletRecord = findOneOrThrow(
          await txn.insert(wallet).values({ userId, balance: '0', currency }).returning(),
          new WalletNotFoundError(userId),
        );
      }

      const { row, replayed } = await this.insertIdempotentTransaction(txn, {
        namespace: DEPOSIT_IDEMPOTENCY_NAMESPACE,
        walletId: walletRecord.id,
        rawIdempotencyKey: idempotencyKey,
        amount,
        currency,
        values: {
          walletId: walletRecord.id,
          type: 'deposit',
          amount,
          currency,
          status: 'completed',
          rail: this.resolveRail(currency),
          providerName: provider,
          providerRefId: psp.externalId,
        },
      });

      if (!replayed) {
        await txn
          .update(wallet)
          .set({ balance: sql`${wallet.balance} + ${amount}::numeric` })
          .where(eq(wallet.id, walletRecord.id));
      }

      return { transactionId: row.id, replayed };
    });

    if (!replayed) {
      this.events.emit('wallet.deposit.completed', {
        userId,
        amount,
        currency,
        transactionId,
      });
    }

    return { transactionId, status: 'completed' };
  }

  // Pre-PSP replay check for deposit; also returns the resolved wallet so the transaction
  // below can skip re-selecting it. Throws IdempotencyKeyReuseError on an amount/currency mismatch.
  private async findDepositReplay({
    userId,
    idempotencyKey,
    amount,
    currency,
  }: {
    userId: User['id'];
    idempotencyKey: string;
    amount: string;
    currency: string;
  }): Promise<{ walletRecord: Wallet | undefined; replay: TransactionResult | undefined }> {
    const [walletRecord] = await this.drizzle.db
      .select()
      .from(wallet)
      .where(eq(wallet.userId, userId));
    if (!walletRecord) {
      return { walletRecord: undefined, replay: undefined };
    }
    const existing = await this.findByIdempotencyKey(
      this.drizzle.db,
      walletRecord.id,
      namespacedIdempotencyKey(DEPOSIT_IDEMPOTENCY_NAMESPACE, idempotencyKey),
    );
    if (!existing) {
      return { walletRecord, replay: undefined };
    }
    this.assertReplayMatches(existing, amount, currency);
    return { walletRecord, replay: { transactionId: existing.id, status: existing.status } };
  }

  // Replay comparison only (not a ledger write) - moneyToNumber avoids a false mismatch
  // between an unnormalized caller string (eg "10") and the DB's fixed-scale value ("10.00").
  private assertReplayMatches(existing: WalletTransaction, amount: string, currency: string): void {
    if (
      moneyToNumber(existing.amount) !== moneyToNumber(amount) ||
      existing.currency.toUpperCase() !== currency.toUpperCase()
    ) {
      throw new IdempotencyKeyReuseError();
    }
  }

  // Two concurrent requests with the same key can both pass the pre-insert check and race
  // on the unique index; onConflictDoNothing makes the loser's insert a no-op so it re-reads
  // the winner's committed row and returns it as a replay instead of aborting the transaction.
  private async insertIdempotentTransaction(
    txn: DrizzleTx,
    {
      namespace,
      walletId,
      rawIdempotencyKey,
      amount,
      currency,
      values,
    }: {
      namespace: string;
      walletId: Wallet['id'];
      rawIdempotencyKey: string | undefined;
      amount: string;
      currency: string;
      values: Omit<typeof walletTransaction.$inferInsert, 'idempotencyKey'>;
    },
  ): Promise<{ row: WalletTransaction; replayed: boolean }> {
    const idempotencyKey = rawIdempotencyKey
      ? namespacedIdempotencyKey(namespace, rawIdempotencyKey)
      : undefined;

    const insertQuery = txn
      .insert(walletTransaction)
      .values({ ...values, idempotencyKey: idempotencyKey ?? null });
    const [row] = idempotencyKey
      ? await insertQuery.onConflictDoNothing().returning()
      : await insertQuery.returning();

    if (row) {
      return { row, replayed: false };
    }

    // Only the keyed (onConflictDoNothing) branch above can return an empty `returning()`
    // - the plain-insert branch always yields exactly one row.
    if (!idempotencyKey) {
      throw new Error(`wallet ${namespace}: insert returned no row`);
    }
    const winner = await this.findByIdempotencyKey(txn, walletId, idempotencyKey);
    if (!winner) {
      throw new Error(
        `wallet ${namespace}: idempotency conflict but no row found (key=${rawIdempotencyKey})`,
      );
    }
    this.assertReplayMatches(winner, amount, currency);
    return { row: winner, replayed: true };
  }

  /**
   * Creates a PENDING withdrawal and HOLDS the funds immediately (balance
   * debited at request time, not on approval) - funds are returned on
   * reject/PSP-failure. The debit is a conditional `UPDATE ... WHERE balance
   * >= amount`, atomic with the row lock (`FOR UPDATE`) taken on the wallet,
   * so two concurrent withdrawals can't both pass a balance check and
   * double-spend. `idempotencyKey` replay semantics mirror `deposit()`. May
   * return an already-`completed`/`processing` result if the request
   * qualifies for (and passes) auto-approval - see `maybeAutoApprove`.
   */
  async withdraw({
    userId,
    amount,
    currency,
    idempotencyKey,
    destinationAddress,
    ip,
    userAgent,
  }: {
    userId: User['id'];
    amount: string;
    currency: string;
    idempotencyKey?: string;
    destinationAddress?: string;
  } & ClientMeta): Promise<TransactionResult> {
    await this.rateLimit(userId);
    await this.assertKycForWithdrawal(userId);
    if (this.resolveRail(currency) === 'crypto' && !destinationAddress) {
      throw new DestinationAddressRequiredError();
    }

    const { transactionId, status, replayed, walletId, rail } = await this.drizzle.db.transaction(
      async (txn) => {
        // FOR UPDATE serializes concurrent withdrawals against a double-debit TOCTOU under READ COMMITTED.
        const current = findOneOrThrow(
          await txn.select().from(wallet).where(eq(wallet.userId, userId)).for('update'),
          new WalletNotFoundError(userId),
        );
        // Single-currency wallet: reject a mismatch rather than coerce it onto the wrong rail.
        if (currency.toUpperCase() !== current.currency.toUpperCase()) {
          throw new CurrencyMismatchError(currency, current.currency);
        }

        // Replay of an already-committed key: return the original untouched. The new-key race is caught by the insert below.
        if (idempotencyKey) {
          const existing = await this.findByIdempotencyKey(
            txn,
            current.id,
            namespacedIdempotencyKey(WITHDRAW_IDEMPOTENCY_NAMESPACE, idempotencyKey),
          );
          if (existing) {
            this.assertReplayMatches(existing, amount, currency);
            return {
              transactionId: existing.id,
              status: existing.status,
              replayed: true,
              walletId: current.id,
              rail: this.resolveRail(currency),
            };
          }
        }

        const { row, replayed } = await this.insertIdempotentTransaction(txn, {
          namespace: WITHDRAW_IDEMPOTENCY_NAMESPACE,
          walletId: current.id,
          rawIdempotencyKey: idempotencyKey,
          amount,
          currency,
          values: {
            walletId: current.id,
            type: 'withdrawal',
            amount,
            currency,
            status: 'pending',
            rail: this.resolveRail(currency),
            destinationAddress: destinationAddress ?? null,
          },
        });

        if (replayed) {
          return {
            transactionId: row.id,
            status: row.status,
            replayed,
            walletId: current.id,
            rail: this.resolveRail(currency),
          };
        }

        // Guarded conditional debit: the WHERE makes balance>=amount atomic with the write; 0 rows back rolls back the whole tx.
        const debited = await txn
          .update(wallet)
          .set({ balance: sql`${wallet.balance} - ${amount}::numeric` })
          .where(and(eq(wallet.id, current.id), gte(wallet.balance, amount)))
          .returning({ id: wallet.id });
        if (debited.length !== 1) {
          throw new InsufficientBalanceError(current.balance, amount);
        }

        // Synchronous, transactional withdrawal_review evaluation - on this SAME txn, so
        // the assignment (if any) commits atomically with this withdrawal request and is
        // guaranteed visible before maybeAutoApprove reads risk tags below. Must run
        // BEFORE that read; never move this after the transaction returns (see
        // TagEvaluationService.evaluateWithdrawalRequested for the race this closes).
        if (this.tagEvaluationCommands) {
          await this.tagEvaluationCommands.evaluateWithdrawalRequested(txn, { userId, amount });
        }

        return {
          transactionId: row.id,
          status: row.status,
          replayed,
          walletId: current.id,
          rail: this.resolveRail(currency),
        };
      },
    );

    if (replayed) {
      return { transactionId, status };
    }

    this.events.emit('wallet.withdrawal.requested', {
      userId,
      amount,
      currency,
      transactionId,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });

    // Fail-closed post-step: decides who approves (system vs manual queue), never throws out of withdraw() - failure leaves the row pending.
    const auto = await this.maybeAutoApprove({
      userId,
      amount,
      currency,
      transactionId,
      walletId,
      rail,
    });
    return auto ?? { transactionId, status };
  }

  async listWithdrawals(filters: WithdrawalQueueFilter) {
    const db = this.drizzle.db;
    const { page, limit } = filters;

    const conditions = [eq(walletTransaction.type, 'withdrawal')];
    if (filters.status) {
      conditions.push(eq(walletTransaction.status, filters.status));
    }
    if (filters.currency) {
      conditions.push(eq(walletTransaction.currency, filters.currency));
    }
    if (filters.rail) {
      conditions.push(eq(walletTransaction.rail, filters.rail));
    }
    if (filters.minAmount !== undefined) {
      conditions.push(gte(walletTransaction.amount, filters.minAmount));
    }
    if (filters.maxAmount !== undefined) {
      conditions.push(lte(walletTransaction.amount, filters.maxAmount));
    }
    if (filters.dateFrom) {
      conditions.push(gte(walletTransaction.createdAt, new Date(filters.dateFrom)));
    }
    if (filters.dateTo) {
      conditions.push(lte(walletTransaction.createdAt, new Date(filters.dateTo)));
    }

    // Bounded queue: fetch all SQL-matching rows, then enrich + kycStatus-filter + paginate in memory,
    // else DB-side pagination makes `total` wrong once kycStatus prunes.
    const wdSortBy = filters.sortBy ?? 'createdAt';
    const wdDir = (filters.sortOrder ?? 'desc') === 'asc' ? asc : desc;
    const WD_SORT_COLS = {
      createdAt: walletTransaction.createdAt,
      amount: walletTransaction.amount,
      status: walletTransaction.status,
      currency: walletTransaction.currency,
      rail: walletTransaction.rail,
      reviewedAt: walletTransaction.reviewedAt,
    } as const;
    const rows = await db
      .select({ tx: walletTransaction, userId: wallet.userId })
      .from(walletTransaction)
      .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
      .where(and(...conditions))
      .orderBy(wdDir(WD_SORT_COLS[wdSortBy]), desc(walletTransaction.id));

    const userIds = [...new Set(rows.map((r) => r.userId))];
    const summaries = this.directory ? await this.directory.lookupPlayers(userIds) : [];
    const byUserId = new Map(summaries.map((s) => [s.userId, s]));

    // Normalize both sides before comparing: the ADMIN_USER_DIRECTORY port's return type
    // still permits the deprecated `verified` value (it aliases `approved`), and this
    // module cannot assume every bound implementation already normalized it at its own
    // read boundary - a raw `===` here would silently hide every legacy-verified player
    // from the queue the moment an admin filters by the canonical `approved`.
    const kycStatusFilter = filters.kycStatus ? normalizeKycStatus(filters.kycStatus) : undefined;
    const matching = kycStatusFilter
      ? rows.filter((r) => {
          const kycStatus = byUserId.get(r.userId)?.kycStatus;
          return kycStatus !== undefined && kycStatus !== null
            ? normalizeKycStatus(kycStatus) === kycStatusFilter
            : false;
        })
      : rows;

    const start = pageToOffset(page, limit);
    const pageRows = matching.slice(start, start + limit);

    // One batched velocity query for the page (no N+1); shares the window + threshold + query the auto-approval evaluator uses.
    const pageWalletIds = [...new Set(pageRows.map((r) => r.tx.walletId))];
    const frequentWalletIds = await this.frequentWithdrawalWalletIds(db, pageWalletIds);

    const items: WithdrawalQueueItem[] = pageRows.map((r) => {
      const summary = byUserId.get(r.userId);
      const riskTags: string[] = [];
      if (moneyToNumber(r.tx.amount) >= moneyToNumber(LARGE_WITHDRAWAL_THRESHOLD)) {
        riskTags.push('large_amount');
      }
      if (frequentWalletIds.has(r.tx.walletId)) {
        riskTags.push('high_frequency');
      }
      return {
        transactionId: r.tx.id,
        userId: r.userId,
        username: summary?.username ?? '',
        amount: r.tx.amount,
        currency: r.tx.currency,
        rail: r.tx.rail ?? null,
        status: r.tx.status,
        kycStatus: summary?.kycStatus ?? null,
        riskTags,
        requestedAt: r.tx.createdAt.toISOString(),
        destinationAddress: r.tx.destinationAddress,
        txHash: r.tx.txHash,
      };
    });

    return { items, total: matching.length, page, limit };
  }

  /**
   * Approve: Pending -> Processing (commit + emit), send to PSP, then Completed on success
   * or Failed + refund on PSP error. Robust PSP idempotency-key/reconciliation for a
   * lost-response is deferred - same scope boundary the deposit path declares.
   */
  async approveWithdrawal(
    adminId: User['id'],
    withdrawalId: WalletTransaction['id'],
    meta?: ClientMeta,
  ): Promise<TransactionResult> {
    // Two-phase: commit the `processing` flip first (FOR UPDATE lock), then call the PSP OUTSIDE
    // the tx (a failure refunds in a second tx). Never inline the PSP call inside the hold transaction.
    const tx = await this.drizzle.db.transaction((txn) =>
      this.flipToProcessing({ txn, withdrawalId, adminId }),
    );
    return this.settleApproved(tx, adminId, meta);
  }

  // Phase one: the pending -> processing flip under a FOR UPDATE lock. Extracted so the auto path can run it
  // inside its advisory-locked cap-check transaction, committing the marker atomically. Never call the PSP here.
  private async flipToProcessing({
    txn,
    withdrawalId,
    adminId,
    reviewReason,
  }: {
    txn: DrizzleTx;
    withdrawalId: WalletTransaction['id'];
    adminId: User['id'] | null;
    reviewReason?: string;
  }): Promise<WalletTransaction> {
    const current = findOneOrThrow(
      await txn
        .select()
        .from(walletTransaction)
        .where(eq(walletTransaction.id, withdrawalId))
        .for('update'),
      new WithdrawalNotFoundError(withdrawalId),
    );
    // Only a pending withdrawal can be approved, so a concurrent or repeated approve can't double-send to the PSP.
    if (current.status !== 'pending' || current.type !== 'withdrawal') {
      throw new WithdrawalNotPendingError();
    }
    return findOneOrThrow(
      await txn
        .update(walletTransaction)
        .set({
          status: 'processing',
          reviewedBy: adminId,
          reviewedAt: new Date(),
          ...(reviewReason !== undefined ? { reviewReason } : {}),
        })
        .where(eq(walletTransaction.id, withdrawalId))
        .returning(),
      new WithdrawalNotFoundError(withdrawalId),
    );
  }

  // Phase two: settle a `processing` withdrawal via the PSP (Completed on success, Failed + refund on error).
  // Runs OUTSIDE the hold/flip transaction so the external PSP call never holds a DB lock.
  private async settleApproved(
    tx: WalletTransaction,
    adminId: User['id'] | null,
    meta?: ClientMeta,
  ): Promise<TransactionResult> {
    const userId = await this.userIdForWallet(tx.walletId);
    const amount = tx.amount;
    // approved/failed are admin-attributed events (schema requires a uuid adminId); the system auto path
    // skips them - its trail is the AUDIT_WRITER entry plus the shared `completed` event below.
    if (adminId) {
      this.events.emit('wallet.withdrawal.approved', {
        userId,
        amount,
        currency: tx.currency,
        transactionId: tx.id,
        adminId,
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
      });
    }

    let result: Awaited<ReturnType<PaymentAdapter['processWithdrawal']>>;
    try {
      result = await this.payment.processWithdrawal(amount, tx.currency, {
        transactionId: tx.id,
        userId,
        rail: tx.rail,
        adminId,
        destinationAddress: tx.destinationAddress,
      });
    } catch (err) {
      // Payout did not happen - mark failed and return the held funds in one transaction.
      await this.finalizeFailedWithdrawal({ tx, adminId, userId, amount });
      throw err;
    }

    if (result.status === 'failed') {
      await this.finalizeFailedWithdrawal({ tx, adminId, userId, amount });
      return { transactionId: tx.id, status: 'failed' };
    }

    if (result.status !== 'completed') {
      await this.drizzle.db
        .update(walletTransaction)
        .set({ providerName: providerNameFor(tx.rail), providerRefId: result.externalId })
        .where(eq(walletTransaction.id, tx.id));
      return { transactionId: tx.id, status: 'processing' };
    }

    await this.drizzle.db
      .update(walletTransaction)
      .set({
        status: 'completed',
        providerName: providerNameFor(tx.rail),
        providerRefId: result.externalId,
      })
      .where(eq(walletTransaction.id, tx.id));
    this.events.emit('wallet.withdrawal.completed', {
      userId,
      amount,
      currency: tx.currency,
      transactionId: tx.id,
    });

    return { transactionId: tx.id, status: 'completed' };
  }

  private async finalizeFailedWithdrawal({
    tx,
    adminId,
    userId,
    amount,
  }: {
    tx: WalletTransaction;
    adminId: User['id'] | null;
    userId: User['id'];
    amount: string;
  }): Promise<void> {
    const transitioned = await this.drizzle.db.transaction(async (txn) => {
      const updated = await txn
        .update(walletTransaction)
        .set({ status: 'failed' })
        .where(and(eq(walletTransaction.id, tx.id), eq(walletTransaction.status, 'processing')))
        .returning({ id: walletTransaction.id });
      if (updated.length === 0) {
        return false;
      }
      await txn
        .update(wallet)
        .set({ balance: sql`${wallet.balance} + ${amount}::numeric` })
        .where(eq(wallet.id, tx.walletId));
      return true;
    });
    if (transitioned && adminId) {
      this.events.emit('wallet.withdrawal.failed', {
        userId,
        amount,
        currency: tx.currency,
        transactionId: tx.id,
        adminId,
      });
    }
  }

  async reconcileWithdrawalStatus(
    event: Extract<PaymentWebhookEvent, { kind: 'withdrawal' }>,
  ): Promise<void> {
    const { externalId, status, txHash } = event;
    const [tx] = await this.drizzle.db
      .select()
      .from(walletTransaction)
      .where(eq(walletTransaction.providerRefId, externalId));
    if (!tx || tx.type !== 'withdrawal') {
      logger.warn({ externalId }, 'payment webhook: no matching withdrawal for providerRefId');
      return;
    }
    if (tx.status !== 'processing') {
      return;
    }

    const userId = await this.userIdForWallet(tx.walletId);

    if (status === 'completed') {
      const updated = await this.drizzle.db
        .update(walletTransaction)
        .set({ status: 'completed', txHash: txHash ?? tx.txHash })
        .where(and(eq(walletTransaction.id, tx.id), eq(walletTransaction.status, 'processing')))
        .returning({ id: walletTransaction.id });
      if (updated.length === 0) {
        return;
      }
      this.events.emit('wallet.withdrawal.completed', {
        userId,
        amount: tx.amount,
        currency: tx.currency,
        transactionId: tx.id,
      });
      return;
    }

    if (status === 'failed') {
      await this.finalizeFailedWithdrawal({ tx, adminId: null, userId, amount: tx.amount });
    }
  }

  // Evaluates the auto-approval gates and settles the payout if all pass; returns undefined to
  // leave the row pending for the manual queue. NEVER throws: any error fails closed to manual.
  private async maybeAutoApprove(args: {
    userId: User['id'];
    amount: string;
    currency: string;
    transactionId: WalletTransaction['id'];
    walletId: Wallet['id'];
    rail: WalletRail;
  }): Promise<TransactionResult | undefined> {
    if (!this.platformConfig?.autoWithdrawal?.enabled) {
      return undefined;
    }

    try {
      const cfg = this.platformConfig.autoWithdrawal;

      // Threshold/KYC/risk/velocity gates run outside any lock; only the cap check below needs serializing.
      const gates = await this.evaluateAutoApproval(args);
      if (!gates) {
        return undefined;
      }

      // Serialize the cap-check-and-flip per user with an advisory lock: without it two concurrent
      // withdrawals read the same daily-cap usage and both auto-approve, bypassing the cap. The cap read
      // and the flip that writes the marker commit together, so a blocked caller re-reads current usage.
      // PSP settlement runs AFTER, outside the lock.
      const decided = await this.drizzle.db.transaction((txn) =>
        withAdvisoryXactLock(txn, args.userId, async () => {
          const caps = await this.autoApprovalCaps(
            { walletId: args.walletId, amount: args.amount, cfg },
            txn,
          );
          if (caps.exceeded) {
            return null;
          }
          const tx = await this.flipToProcessing({
            txn,
            withdrawalId: args.transactionId,
            adminId: null,
            reviewReason: AUTO_APPROVED_REASON,
          });
          return { tx, caps };
        }),
      );
      if (!decided) {
        return undefined;
      }

      const decision: AutoApprovalDecision = {
        ...gates,
        dailyCapAmount: cfg.dailyCapAmount ?? null,
        dailyCapCount: cfg.dailyCapCount ?? null,
        cumulativeAmountUsed: decided.caps.amountUsed,
        cumulativeCountUsed: decided.caps.countUsed,
      };

      // Record the decision BEFORE settling: a later PSP failure must not erase the AML trail of why we auto-approved.
      try {
        await this.audit.record({
          actorType: 'system',
          action: 'wallet.withdrawal.auto_approved',
          resourceType: 'wallet_transaction',
          resourceId: args.transactionId,
          after: {
            userId: args.userId,
            amount: args.amount,
            currency: args.currency,
            ...decision,
          },
        });
      } catch (err) {
        // The flip already committed; an audit-write failure must not strand the row `processing`
        // with no PSP attempt, so revert to `pending` before rethrowing (held funds are unaffected).
        await this.drizzle.db
          .update(walletTransaction)
          .set({ status: 'pending', reviewedBy: null, reviewedAt: null, reviewReason: null })
          .where(eq(walletTransaction.id, args.transactionId));
        throw err;
      }

      return await this.settleApproved(decided.tx, null);
    } catch (err) {
      // Fail closed: any thrown gate leaves the withdrawal pending for a human rather than paying out.
      logger.error({ err, transactionId: args.transactionId }, 'auto-withdrawal evaluation failed');
      return undefined;
    }
  }

  // Pre-lock gates: threshold, KYC, risk flags, velocity. Returns the gate values on a pass, null to
  // route to manual. The daily-cap check is NOT here - it runs under the advisory lock (see maybeAutoApprove).
  private async evaluateAutoApproval({
    userId,
    amount,
    walletId,
    rail,
  }: {
    userId: User['id'];
    amount: string;
    walletId: Wallet['id'];
    rail: WalletRail;
  }): Promise<AutoApprovalGates | null> {
    const cfg = this.platformConfig?.autoWithdrawal;
    if (!cfg?.enabled) {
      return null;
    }
    const threshold = await this.resolveAutoThreshold(userId, rail);
    if (!threshold || moneyToNumber(threshold.value) <= 0) {
      return null;
    }
    if (moneyToNumber(amount) > moneyToNumber(threshold.value)) {
      return null;
    }

    // Independent of kyc.gateWithdrawals: auto-approval always demands a passing status; anything else fails closed.
    const kycStatus = await this.autoApprovalKycStatus(userId);
    if (!kycStatus || !KYC_PASS_STATUSES.has(normalizeKycStatus(kycStatus))) {
      return null;
    }

    const riskTags = await this.autoApprovalRiskTags(userId, cfg.excludeRiskFlags);
    // null = exclusions configured but the lookup port is unavailable => fail closed.
    if (riskTags === null) {
      return null;
    }
    if (riskTags.some((t) => cfg.excludeRiskFlags.includes(t))) {
      return null;
    }

    const heuristics = await this.autoApprovalHeuristics({ walletId, amount });
    if (heuristics.largeAmount || heuristics.highFrequency) {
      return null;
    }

    return {
      threshold: threshold.value,
      thresholdSource: threshold.source,
      kycStatus,
      riskTagsEvaluated: riskTags,
    };
  }

  private async resolveAutoThreshold(
    userId: User['id'],
    rail: WalletRail,
  ): Promise<{ value: string; source: 'per-player' | 'global' } | null> {
    const [rule] = await this.drizzle.db
      .select()
      .from(autoWithdrawalRule)
      .where(eq(autoWithdrawalRule.userId, userId));
    if (rule) {
      return { value: rule.threshold, source: 'per-player' };
    }
    const global =
      rail === 'crypto'
        ? this.platformConfig?.autoWithdrawal?.cryptoThreshold
        : this.platformConfig?.autoWithdrawal?.fiatThreshold;
    if (global !== undefined) {
      return { value: global, source: 'global' };
    }
    return null;
  }

  private async autoApprovalKycStatus(userId: User['id']): Promise<KycStatus | null> {
    // No directory bound => cannot verify KYC => fail closed.
    if (!this.directory) {
      return null;
    }
    const [summary] = await this.directory.lookupPlayers([userId]);
    return summary?.kycStatus ?? null;
  }

  // Active tag keys; [] when no exclusions configured or none carried; null when configured but the port is unbound (fail closed).
  private async autoApprovalRiskTags(
    userId: User['id'],
    excludeRiskFlags: readonly TagKey[],
  ): Promise<TagKey[] | null> {
    if (excludeRiskFlags.length === 0) {
      return [];
    }
    if (!this.riskTags) {
      return null;
    }
    const byUser = await this.riskTags.getActiveTagKeys([userId]);
    return byUser.get(userId) ?? [];
  }

  private async autoApprovalHeuristics({
    walletId,
    amount,
  }: {
    walletId: Wallet['id'];
    amount: string;
  }): Promise<{ largeAmount: boolean; highFrequency: boolean }> {
    const frequent = await this.frequentWithdrawalWalletIds(this.drizzle.db, [walletId]);
    return {
      largeAmount: moneyToNumber(amount) >= moneyToNumber(LARGE_WITHDRAWAL_THRESHOLD),
      highFrequency: frequent.has(walletId),
    };
  }

  // Wallets with >= HIGH_FREQUENCY_MIN_COUNT withdrawals in the trailing window, via one grouped-count query (no N+1).
  // Single source of the velocity check, shared by the review queue tag and the auto-approval heuristic.
  private async frequentWithdrawalWalletIds(
    db: DrizzleDb | DrizzleTx,
    walletIds: string[],
  ): Promise<Set<string>> {
    const frequent = new Set<string>();
    if (walletIds.length === 0) {
      return frequent;
    }
    const since = new Date(Date.now() - HIGH_FREQUENCY_WINDOW_MS);
    const counts = await db
      .select({ walletId: walletTransaction.walletId, n: count() })
      .from(walletTransaction)
      .where(
        and(
          eq(walletTransaction.type, 'withdrawal'),
          gte(walletTransaction.createdAt, since),
          inArray(walletTransaction.walletId, walletIds),
        ),
      )
      .groupBy(walletTransaction.walletId);
    for (const row of counts) {
      if (Number(row.n) >= HIGH_FREQUENCY_MIN_COUNT) {
        frequent.add(row.walletId);
      }
    }
    return frequent;
  }

  // Sum + count of this wallet's auto-approved payouts in the trailing 24h; `exceeded` when this withdrawal
  // would breach a configured amount or count cap (an unconfigured cap never blocks).
  private async autoApprovalCaps(
    {
      walletId,
      amount,
      cfg,
    }: {
      walletId: Wallet['id'];
      amount: string;
      cfg: NonNullable<PlatformConfig['autoWithdrawal']>;
    },
    db: DrizzleTx,
  ): Promise<{ exceeded: boolean; amountUsed: string; countUsed: number }> {
    const since = new Date(Date.now() - DAILY_CAP_WINDOW_MS);
    const [row] = await db
      .select({
        total: sql<string>`coalesce(sum(${walletTransaction.amount}), 0)`,
        n: count(),
      })
      .from(walletTransaction)
      .where(
        and(
          eq(walletTransaction.walletId, walletId),
          eq(walletTransaction.type, 'withdrawal'),
          eq(walletTransaction.reviewReason, AUTO_APPROVED_REASON),
          gte(walletTransaction.createdAt, since),
        ),
      );
    const amountUsed = row?.total ?? '0';
    const countUsed = Number(row?.n ?? 0);
    // Cap comparison is a review-queue decision, not a ledger write - moneyToNumber is the
    // documented single conversion point (see the helper's own doc comment).
    const amountExceeded =
      cfg.dailyCapAmount !== undefined &&
      moneyToNumber(amountUsed) + moneyToNumber(amount) > moneyToNumber(cfg.dailyCapAmount);
    const countExceeded = cfg.dailyCapCount !== undefined && countUsed + 1 > cfg.dailyCapCount;
    return { exceeded: amountExceeded || countExceeded, amountUsed, countUsed };
  }

  async setAutoWithdrawalRule({
    userId,
    threshold,
    reason,
    createdBy,
  }: {
    userId: User['id'];
    threshold: string;
    reason: string;
    createdBy: string;
  }): Promise<AutoWithdrawalRule> {
    const row = findOneOrThrow(
      await this.drizzle.db
        .insert(autoWithdrawalRule)
        .values({ userId, threshold, reason, createdBy })
        .onConflictDoUpdate({
          target: autoWithdrawalRule.userId,
          set: { threshold, reason, createdBy },
        })
        .returning(),
      new WalletNotFoundError(userId),
    );
    return toAutoWithdrawalRuleDto(row);
  }

  async getAutoWithdrawalRule(userId: User['id']): Promise<AutoWithdrawalRule | null> {
    const [row] = await this.drizzle.db
      .select()
      .from(autoWithdrawalRule)
      .where(eq(autoWithdrawalRule.userId, userId));
    return row ? toAutoWithdrawalRuleDto(row) : null;
  }

  async deleteAutoWithdrawalRule(userId: User['id']): Promise<boolean> {
    const deleted = await this.drizzle.db
      .delete(autoWithdrawalRule)
      .where(eq(autoWithdrawalRule.userId, userId))
      .returning({ id: autoWithdrawalRule.id });
    return deleted.length > 0;
  }

  async rejectWithdrawal(
    adminId: User['id'],
    withdrawalId: WalletTransaction['id'],
    reason: string,
    meta?: ClientMeta,
  ): Promise<TransactionResult> {
    const reviewedAt = new Date();

    const tx = await this.drizzle.db.transaction(async (txn) => {
      const current = findOneOrThrow(
        await txn
          .select()
          .from(walletTransaction)
          .where(eq(walletTransaction.id, withdrawalId))
          .for('update'),
        new WithdrawalNotFoundError(withdrawalId),
      );
      if (current.status !== 'pending' || current.type !== 'withdrawal') {
        throw new WithdrawalNotPendingError();
      }
      const updated = findOneOrThrow(
        await txn
          .update(walletTransaction)
          .set({ status: 'rejected', reviewedBy: adminId, reviewedAt, reviewReason: reason })
          .where(eq(walletTransaction.id, withdrawalId))
          .returning(),
        new WithdrawalNotFoundError(withdrawalId),
      );

      await txn
        .update(wallet)
        .set({ balance: sql`${wallet.balance} + ${updated.amount}::numeric` })
        .where(eq(wallet.id, updated.walletId));

      return updated;
    });

    const userId = await this.userIdForWallet(tx.walletId);
    this.events.emit('wallet.withdrawal.rejected', {
      userId,
      amount: tx.amount,
      currency: tx.currency,
      transactionId: tx.id,
      adminId,
      reason,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });

    return { transactionId: tx.id, status: 'rejected' };
  }

  async getTransactions({
    userId,
    page,
    limit,
    sortBy,
    sortOrder,
  }: PaginationOptions<{ userId: User['id'] }, WalletTransactionSortBy>) {
    const db = this.drizzle.db;

    const [walletRecord] = await db.select().from(wallet).where(eq(wallet.userId, userId));
    if (!walletRecord) {
      return { items: [], total: 0, page, limit };
    }
    const dir = (sortOrder ?? 'desc') === 'asc' ? asc : desc;
    const TX_SORT_COLS = {
      createdAt: walletTransaction.createdAt,
      amount: walletTransaction.amount,
      type: walletTransaction.type,
      status: walletTransaction.status,
      currency: walletTransaction.currency,
      rail: walletTransaction.rail,
      reviewedAt: walletTransaction.reviewedAt,
    } as const;
    const col = TX_SORT_COLS[sortBy ?? 'createdAt'];
    const where = eq(walletTransaction.walletId, walletRecord.id);
    const [txs, [{ n }]] = await Promise.all([
      db
        .select()
        .from(walletTransaction)
        .where(where)
        .orderBy(dir(col), desc(walletTransaction.id))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      db.select({ n: count() }).from(walletTransaction).where(where),
    ]);
    return {
      items: txs.map((tx) => ({
        id: tx.id,
        type: tx.type,
        amount: tx.amount,
        currency: tx.currency,
        status: tx.status,
        createdAt: tx.createdAt.toISOString(),
      })),
      total: Number(n),
      page,
      limit,
    };
  }

  async getOrCreateDepositAddress(
    userId: User['id'],
    currency: string,
  ): Promise<{ address: string; currency: string }> {
    const existing = await this.findDepositAddress(userId, currency);
    if (existing) {
      return { address: existing.address, currency: existing.currency };
    }
    if (!this.payment.issueDepositAddress) {
      throw new DepositAddressUnsupportedError();
    }
    const issued = await this.payment.issueDepositAddress(userId, currency);

    const [row] = await this.drizzle.db
      .insert(walletDepositAddress)
      .values({
        userId,
        currency,
        address: issued.address,
        providerName: providerNameFor(this.resolveRail(currency)),
      })
      .onConflictDoNothing()
      .returning();
    if (row) {
      return { address: row.address, currency: row.currency };
    }
    const winner = await this.findDepositAddress(userId, currency);
    if (!winner) {
      throw new Error(
        `wallet deposit address: idempotency conflict but no row found (userId=${userId}, currency=${currency})`,
      );
    }
    return { address: winner.address, currency: winner.currency };
  }

  async creditDepositByAddress(
    event: Extract<PaymentWebhookEvent, { kind: 'deposit' }>,
  ): Promise<void> {
    const depositAddress = await this.findDepositAddressByAddress(event.address);
    if (!depositAddress) {
      logger.warn(
        { address: event.address },
        'payment webhook: no wallet_deposit_address for inbound deposit',
      );
      return;
    }
    if (event.currency.toUpperCase() !== depositAddress.currency.toUpperCase()) {
      throw new CurrencyMismatchError(event.currency, depositAddress.currency);
    }

    const { transactionId, replayed } = await this.drizzle.db.transaction(async (txn) => {
      let [walletRecord] = await txn
        .select()
        .from(wallet)
        .where(eq(wallet.userId, depositAddress.userId));
      if (!walletRecord) {
        walletRecord = findOneOrThrow(
          await txn
            .insert(wallet)
            .values({ userId: depositAddress.userId, balance: '0', currency: event.currency })
            .returning(),
          new WalletNotFoundError(depositAddress.userId),
        );
      } else if (walletRecord.currency.toUpperCase() !== event.currency.toUpperCase()) {
        throw new CurrencyMismatchError(event.currency, walletRecord.currency);
      }

      const [inserted] = await txn
        .insert(walletTransaction)
        .values({
          walletId: walletRecord.id,
          type: 'deposit',
          amount: event.amount,
          currency: event.currency,
          status: 'completed',
          rail: this.resolveRail(event.currency),
          providerName: depositAddress.providerName,
          providerRefId: event.externalId,
          destinationAddress: event.address,
          txHash: event.txHash,
        })
        .onConflictDoNothing()
        .returning();

      if (inserted) {
        await txn
          .update(wallet)
          .set({ balance: sql`${wallet.balance} + ${event.amount}::numeric` })
          .where(eq(wallet.id, walletRecord.id));
        return { transactionId: inserted.id, replayed: false };
      }

      const [winner] = await txn
        .select()
        .from(walletTransaction)
        .where(eq(walletTransaction.providerRefId, event.externalId));
      if (!winner) {
        throw new Error(
          `payment webhook: idempotency conflict but no row found (externalId=${event.externalId})`,
        );
      }
      return { transactionId: winner.id, replayed: true };
    });

    if (!replayed) {
      this.events.emit('wallet.deposit.completed', {
        userId: depositAddress.userId,
        amount: event.amount,
        currency: event.currency,
        transactionId,
      });
    }
  }

  private async userIdForWallet(walletId: Wallet['id']) {
    const record = findOneOrThrow(
      await this.drizzle.db
        .select({ userId: wallet.userId })
        .from(wallet)
        .where(eq(wallet.id, walletId)),
      new WalletNotFoundError(walletId),
    );
    return record.userId;
  }

  private async findByIdempotencyKey(
    txn: DrizzleDb | DrizzleTx,
    walletId: Wallet['id'],
    idempotencyKey: string,
  ) {
    const [existing] = await txn
      .select()
      .from(walletTransaction)
      .where(
        and(
          eq(walletTransaction.walletId, walletId),
          eq(walletTransaction.idempotencyKey, idempotencyKey),
        ),
      );
    return existing;
  }

  private async findDepositAddress(userId: User['id'], currency: string) {
    const [row] = await this.drizzle.db
      .select()
      .from(walletDepositAddress)
      .where(
        and(eq(walletDepositAddress.userId, userId), eq(walletDepositAddress.currency, currency)),
      );
    return row;
  }

  private async findDepositAddressByAddress(address: string) {
    const [row] = await this.drizzle.db
      .select()
      .from(walletDepositAddress)
      .where(eq(walletDepositAddress.address, address));
    return row;
  }
}
