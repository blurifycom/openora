import {
  type EventBus,
  type DrizzleDb,
  type DrizzleTx,
  makeNotFoundError,
  serializeRow,
  makeConflictError,
  createDomainError,
  DrizzleService,
  findOneOrThrow,
  pageToOffset,
  withAdvisoryXactLock,
  assertRateLimit,
  createLogger,
  moneyToNumber,
  moneyEquals,
  moneyAdd,
  moneyCompare,
  moneySubtract,
} from '@openora/core/server';
import {
  normalizeKycStatus,
  DEFAULT_PAYMENT_PROVIDER,
  type PaymentAdapter,
  type PaymentProviderRegistry,
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
  type IdentityReader,
  type ClientMeta,
  type Uuid,
  type PaginationOptions,
} from '@openora/core/contracts';
import { eq, asc, desc, sql, and, gte, lte, count, inArray, isNull, or } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import {
  wallet,
  walletBalance,
  walletTransaction,
  autoWithdrawalRule,
  walletAutoWithdrawalConfig,
  walletDepositAddress,
  walletBonusCredit,
  walletBonusRolloverConfig,
  walletWithdrawalAddress,
  walletAsset,
  type Wallet,
  type WalletDepositAddress,
  type WalletTransaction,
  type AutoWithdrawalRule as AutoWithdrawalRuleRow,
  type WalletAutoWithdrawalConfig as WalletAutoWithdrawalConfigRow,
  type WalletBonusCredit as WalletBonusCreditRow,
  type WalletBonusRolloverConfig as WalletBonusRolloverConfigRow,
  type WalletAssetRow,
  type WalletWithdrawalAddressRow,
} from '../schema/index.js';
import {
  LIVE_WEBHOOK_RUN_ID,
  recordReconciliationFinding,
} from './reconciliation-finding.service.js';
import type {
  TransactionResult,
  WithdrawalQueueItem,
  WithdrawalQueueFilter,
  AutoWithdrawalRule,
  WalletAutoWithdrawalConfig,
  WalletTransactionSortBy,
  BonusCredit,
  BonusCreditStatus,
  BonusRolloverConfig,
  WalletAsset,
  PublicWalletAsset,
  CreateWalletAssetInput,
  UpdateWalletAssetInput,
  ManualAdjustmentDirection,
  WithdrawalAddress,
  CreateWithdrawalAddressInput,
} from '../contract/index.js';

const logger = createLogger('wallet');

export const WalletNotFoundError = makeNotFoundError('Wallet');
export const WithdrawalNotFoundError = makeNotFoundError('Withdrawal');
export const AutoWithdrawalConfigNotFoundError = makeNotFoundError('AutoWithdrawalConfig');
export const BonusRolloverConfigNotFoundError = makeNotFoundError('BonusRolloverConfig');
export const PlayerNotFoundError = makeNotFoundError('Player');

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

export const BonusRolloverLockedError = createDomainError<[locked: string]>(
  'BonusRolloverLockedError',
  (locked) => `Withdrawal blocked: ${locked} is locked by an active bonus rollover requirement`,
);

export const DestinationAddressNotWhitelistedError = makeConflictError(
  'DestinationAddressNotWhitelistedError',
  'This payout address is not approved for withdrawals. Save it in your address book first',
);

export const WalletAssetNotFoundError = makeNotFoundError('WalletAsset');

export const WalletAssetAlreadyExistsError = makeConflictError(
  'WalletAssetAlreadyExistsError',
  'An asset is already configured for this currency and network',
);

export const WalletAssetUnsupportedError = makeConflictError(
  'WalletAssetUnsupportedError',
  'The bound payment adapter cannot serve this currency and network',
);

export const WalletAssetInUseError = makeConflictError(
  'WalletAssetInUseError',
  'Players still hold a balance in this currency',
);

export const WalletAssetUnknownProviderError = makeConflictError(
  'WalletAssetUnknownProviderError',
  'providerName is not a registered payment provider',
);

export const WalletAssetHasInFlightTransactionsError = makeConflictError(
  'WalletAssetHasInFlightTransactionsError',
  'A pending or processing transaction exists for this currency and network',
);

export const WithdrawalAddressAlreadyExistsError = makeConflictError(
  'WithdrawalAddressAlreadyExistsError',
  'This address is already saved for that currency and network',
);

export const WithdrawalAddressLimitReachedError = createDomainError<[limit: number]>(
  'WithdrawalAddressLimitReachedError',
  (limit) => `A player may save at most ${limit} withdrawal addresses`,
);

export const AmbiguousNetworkError = createDomainError(
  'AmbiguousNetworkError',
  (currency, networks) =>
    `Currency ${currency} settles on several networks (${networks}) - a network is required`,
);

export const UnsupportedNetworkError = createDomainError(
  'UnsupportedNetworkError',
  (currency, network) => `Currency ${currency} is not settled on network ${network}`,
);

export const WithdrawalDisabledError = createDomainError(
  'WithdrawalDisabledError',
  (currency) => `Withdrawals are disabled for ${currency} on every configured network`,
);

export const BelowMinimumWithdrawalError = createDomainError(
  'BelowMinimumWithdrawalError',
  (amount, minimum, currency, network) =>
    `Withdrawal of ${amount} ${currency} on ${network} is below the ${minimum} ${currency} minimum`,
);

const KYC_PASS_STATUSES: ReadonlySet<KycStatus> = new Set(['approved', 'manually_overridden']);

export const AmbiguousDepositAddressError = createDomainError(
  'AmbiguousDepositAddressError',
  (address, network) =>
    `Deposit address ${address} on ${network ?? 'an unknown network'} is issued to more than one user`,
);

// Crypto currencies settle on the crypto rail through a custody/MPC vendor; everything
// else on the fiat rail (a PSP). The concrete provider is recorded per transaction, not
// here. Overridable per-operator via `platformConfig.wallet.cryptoCurrencies` - see `railFor`.
const DEFAULT_CRYPTO_CURRENCIES = new Set(['BTC', 'ETH', 'USDT', 'USDC']);

// A saved-address book, not a payout allowlist: the cap only stops one account turning
// the table into unbounded free storage. Not operator-configurable until someone asks.
const WITHDRAWAL_ADDRESS_LIMIT = 50;

function toWithdrawalAddressDto(row: WalletWithdrawalAddressRow): WithdrawalAddress {
  return {
    id: row.id,
    label: row.label,
    currency: row.currency,
    network: row.network,
    address: row.address,
    destinationTag: row.destinationTag,
    createdAt: row.createdAt.toISOString(),
  };
}

// Mirrors the `wallet.currency` column default: what a player without a wallet row
// reads as their active currency before one is created on first deposit.
const DEFAULT_WALLET_CURRENCY = 'USD';

// Per-user throttle on money mutations - guards a runaway/misbehaving client, not
// fraud (idempotency + the ledger guard cover correctness). An overlay rebinds
// RATE_LIMITER to change the backend, not this policy.
const WALLET_MUTATION_RATE_LIMIT = { limit: 30, windowMs: 60 * 1000 };

/** The catalog fields a payout decision needs - a structural subset of a wallet_asset row. */
type WithdrawalAsset = {
  network: string;
  minWithdrawal: string;
  withdrawalEnabled: boolean;
};

/**
 * Pins the chain a payout settles on. With one payable network the choice is implied; with
 * several an explicit network is mandatory, because picking one silently would send a
 * player's USDT over a chain their receiving wallet may not support.
 *
 * `assets` is every catalog row for the currency, enabled or not, so the two empty cases
 * stay distinguishable: no rows at all means the operator never configured this currency
 * (a fiat PSP), and the caller's choice passes through unchecked; rows that are all
 * withdrawal-disabled is a deliberate operator decision and fails closed.
 */
export function resolveWithdrawalNetwork(
  assets: readonly WithdrawalAsset[],
  currency: string,
  network?: string,
): string | null {
  if (assets.length === 0) {
    return network?.toUpperCase() ?? null;
  }
  const payable = assets.filter((asset) => asset.withdrawalEnabled);
  const [only, ...rest] = payable;
  if (!only) {
    throw new WithdrawalDisabledError(currency);
  }
  if (network === undefined) {
    if (rest.length > 0) {
      throw new AmbiguousNetworkError(currency, payable.map((asset) => asset.network).join(', '));
    }
    return only.network.toUpperCase();
  }
  const wanted = network.toUpperCase();
  if (!payable.some((asset) => asset.network.toUpperCase() === wanted)) {
    throw new UnsupportedNetworkError(currency, wanted);
  }
  return wanted;
}

/**
 * Rejects a payout worth less than the operator's per-network floor. The floor is per chain,
 * not per currency: moving USDT costs cents on BEP20 and dollars on ERC20, so one
 * currency-wide minimum is either too high for the cheap chain or below the fee on the
 * expensive one.
 */
export function assertAboveMinimumWithdrawal(
  assets: readonly WithdrawalAsset[],
  amount: string,
  currency: string,
  network: string | null,
): void {
  const asset = assets.find(
    (candidate) => candidate.withdrawalEnabled && candidate.network.toUpperCase() === network,
  );
  if (asset && moneyCompare(amount, asset.minWithdrawal) < 0) {
    throw new BelowMinimumWithdrawalError(amount, asset.minWithdrawal, currency, asset.network);
  }
}

export function railFor(currency: string, cryptoCurrencies?: readonly string[]): WalletRail {
  const set = cryptoCurrencies
    ? new Set(cryptoCurrencies.map((c) => c.toUpperCase()))
    : DEFAULT_CRYPTO_CURRENCIES;
  return set.has(currency.toUpperCase()) ? 'crypto' : 'fiat';
}

// Currency checks elsewhere are case-insensitive, so `usd` reaches here for a `USD`
// wallet. Every read and write of wallet_balance funnels through these three helpers,
// so normalizing the key here is enough to keep one row per wallet+currency.
export const balanceKey = (currency: string) => currency.toUpperCase();

export function creditWalletBalance(
  txn: DrizzleDb,
  walletId: Wallet['id'],
  currency: string,
  amount: string,
) {
  return txn
    .insert(walletBalance)
    .values({ walletId, currency: balanceKey(currency), amount })
    .onConflictDoUpdate({
      target: [walletBalance.walletId, walletBalance.currency],
      set: {
        amount: sql`${walletBalance.amount} + ${amount}::numeric`,
        updatedAt: new Date(),
      },
    })
    .returning({ amount: walletBalance.amount });
}

export function debitWalletBalance(
  txn: DrizzleDb,
  walletId: Wallet['id'],
  currency: string,
  amount: string,
) {
  return txn
    .update(walletBalance)
    .set({ amount: sql`${walletBalance.amount} - ${amount}::numeric` })
    .where(
      and(
        eq(walletBalance.walletId, walletId),
        eq(walletBalance.currency, balanceKey(currency)),
        gte(walletBalance.amount, amount),
      ),
    )
    .returning({ amount: walletBalance.amount });
}

export async function readWalletBalance(
  txn: DrizzleDb,
  walletId: Wallet['id'],
  currency: string,
): Promise<string> {
  const [row] = await txn
    .select({ amount: walletBalance.amount })
    .from(walletBalance)
    .where(
      and(eq(walletBalance.walletId, walletId), eq(walletBalance.currency, balanceKey(currency))),
    );
  return row?.amount ?? '0';
}

export function debitWithdrawableBalance(
  txn: DrizzleDb,
  walletId: Wallet['id'],
  currency: string,
  amount: string,
) {
  const currencyKey = balanceKey(currency);

  return txn
    .update(walletBalance)
    .set({ amount: sql`${walletBalance.amount} - ${amount}::numeric` })
    .where(
      and(
        eq(walletBalance.walletId, walletId),
        eq(walletBalance.currency, currencyKey),
        gte(
          sql`${walletBalance.amount} - COALESCE((
            SELECT SUM(
              ${walletBonusCredit.creditedAmount}
              * GREATEST(
                ${walletBonusCredit.rolloverRequired} - ${walletBonusCredit.rolloverProgress},
                0
              )
              / NULLIF(${walletBonusCredit.rolloverRequired}, 0)
            )
            FROM ${walletBonusCredit}
            WHERE ${walletBonusCredit.walletId} = ${walletId}
              AND ${walletBonusCredit.currency} = ${currencyKey}
              AND ${walletBonusCredit.status} = 'active'
          ), 0)`,
          amount,
        ),
      ),
    )
    .returning({ amount: walletBalance.amount });
}

async function readLockedBonusAmount(
  txn: DrizzleDb,
  walletId: Wallet['id'],
  currency: string,
): Promise<string> {
  const currencyKey = balanceKey(currency);
  const [row] = await txn
    .select({
      locked: sql<string>`coalesce(sum(
        ${walletBonusCredit.creditedAmount}
        * greatest(${walletBonusCredit.rolloverRequired} - ${walletBonusCredit.rolloverProgress}, 0)
        / nullif(${walletBonusCredit.rolloverRequired}, 0)
      ), 0)`,
    })
    .from(walletBonusCredit)
    .where(
      and(
        eq(walletBonusCredit.walletId, walletId),
        eq(walletBonusCredit.currency, currencyKey),
        eq(walletBonusCredit.status, 'active'),
      ),
    );
  return row?.locked ?? '0';
}

// Namespace the key per operation so the same raw key on a deposit then a withdraw can't
// collide on the (walletId, idempotencyKey) unique index. The column is a uuid, so a string
// prefix won't parse - hash namespace + key into a stable pseudo-uuid instead.
const DEPOSIT_IDEMPOTENCY_NAMESPACE = 'deposit';
const WITHDRAW_IDEMPOTENCY_NAMESPACE = 'withdraw';
const MANUAL_ADJUSTMENT_IDEMPOTENCY_NAMESPACE = 'manual-adjustment';

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
  effectiveExcludeTags: TagKey[];
  dailyCapAmount: string | null;
  dailyCapCount: number | null;
  cumulativeAmountUsed: string;
  cumulativeCountUsed: number;
};

// The pre-lock portion of the decision, resolvable without the advisory-locked cap read.
type AutoApprovalGates = Pick<
  AutoApprovalDecision,
  'threshold' | 'thresholdSource' | 'kycStatus' | 'riskTagsEvaluated' | 'effectiveExcludeTags'
>;

type DepositAddressResult = {
  address: string;
  currency: string;
  network?: string;
  tag?: string;
};

function toDepositAddressResult(row: WalletDepositAddress): DepositAddressResult {
  return {
    address: row.address,
    currency: row.currency,
    ...(row.network === null ? {} : { network: row.network }),
    ...(row.tag === null ? {} : { tag: row.tag }),
  };
}

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

function toAutoWithdrawalConfigDto(row: WalletAutoWithdrawalConfigRow): WalletAutoWithdrawalConfig {
  return {
    id: row.id,
    fiatThreshold: row.fiatThreshold,
    cryptoThreshold: row.cryptoThreshold,
    excludeRiskFlags: row.excludeRiskFlags,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function toBonusCreditDto(row: WalletBonusCreditRow): BonusCredit {
  return {
    id: row.id,
    currency: row.currency,
    sourceType: row.sourceType,
    creditedAmount: row.creditedAmount,
    rolloverMultiplier: row.rolloverMultiplier,
    rolloverRequired: row.rolloverRequired,
    rolloverProgress: row.rolloverProgress,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

function toBonusRolloverConfigDto(row: WalletBonusRolloverConfigRow): BonusRolloverConfig {
  return {
    id: row.id,
    multiplier: row.multiplier,
    updatedAt: row.updatedAt.toISOString(),
  };
}

const PUBLIC_ASSET_COLUMNS = {
  currency: walletAsset.currency,
  network: walletAsset.network,
  minDeposit: walletAsset.minDeposit,
  minWithdrawal: walletAsset.minWithdrawal,
  withdrawalFee: walletAsset.withdrawalFee,
  depositEnabled: walletAsset.depositEnabled,
  withdrawalEnabled: walletAsset.withdrawalEnabled,
};

function toWalletAssetDto(row: WalletAssetRow): WalletAsset {
  return serializeRow(row, { dateFields: ['createdAt', 'updatedAt'], decimalFields: [] });
}

export type WalletServiceDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  payment: PaymentAdapter;
  // Required: always bound (wallet/plugin.ts wraps the default single PAYMENT_ADAPTER/
  // PAYMENT_WEBHOOK_VERIFIER tokens under DEFAULT_PAYMENT_PROVIDER), and the asset
  // catalog's providerName write path needs it to fail closed on an unregistered name.
  paymentProviders: PaymentProviderRegistry;
  identityReader: IdentityReader;
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
  private readonly paymentProviders: PaymentProviderRegistry;
  private readonly identityReader: IdentityReader;
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
    paymentProviders,
    directory,
    identityReader,
    platformConfig,
    limiter,
    riskTags,
    tagEvaluationCommands,
    audit,
  }: WalletServiceDeps) {
    this.drizzle = drizzle;
    this.events = events;
    this.payment = payment;
    this.paymentProviders = paymentProviders;
    this.directory = directory;
    this.identityReader = identityReader;
    this.platformConfig = platformConfig;
    this.limiter = limiter;
    this.riskTags = riskTags;
    this.tagEvaluationCommands = tagEvaluationCommands;
    this.audit = audit;
  }

  // Every catalog row for the currency, enabled or not - resolveWithdrawalNetwork needs
  // both to tell "never configured" from "deliberately disabled".
  private assetsForCurrency(currency: string) {
    return this.drizzle.db
      .select({
        network: walletAsset.network,
        minWithdrawal: walletAsset.minWithdrawal,
        withdrawalEnabled: walletAsset.withdrawalEnabled,
      })
      .from(walletAsset)
      .where(eq(walletAsset.currency, currency.toUpperCase()));
  }

  private resolveRail(currency: string): WalletRail {
    return railFor(currency, this.platformConfig?.wallet?.cryptoCurrencies);
  }

  // The concrete vendor a transaction/deposit-address settles through: the catalog row
  // for the exact (currency, network) pair names the bound provider. Reconciliation
  // scopes its diff by this column, so a null network (an unconfigured pair - no
  // catalog row could ever match it) and a configured-but-null providerName column both
  // resolve to the single default binding rather than leaving the column null.
  private async providerNameFor(currency: string, network: string | null): Promise<string> {
    if (network === null) {
      return DEFAULT_PAYMENT_PROVIDER;
    }
    const [row] = await this.drizzle.db
      .select({ providerName: walletAsset.providerName })
      .from(walletAsset)
      .where(and(eq(walletAsset.currency, currency), eq(walletAsset.network, network)));
    return row?.providerName ?? DEFAULT_PAYMENT_PROVIDER;
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
      return { balance: '0', currency: DEFAULT_WALLET_CURRENCY };
    }

    return {
      balance: await readWalletBalance(this.drizzle.db, record.id, record.currency),
      currency: record.currency,
    };
  }

  async getBalances(userId: User['id']) {
    const [record] = await this.drizzle.db.select().from(wallet).where(eq(wallet.userId, userId));

    if (!record) {
      return { activeCurrency: DEFAULT_WALLET_CURRENCY, balances: [] };
    }

    const rows = await this.drizzle.db
      .select({ currency: walletBalance.currency, balance: walletBalance.amount })
      .from(walletBalance)
      .where(eq(walletBalance.walletId, record.id))
      .orderBy(walletBalance.currency);

    return { activeCurrency: record.currency, balances: rows };
  }

  // TODO: validate `currency` against a canonical supported-currency list once one
  // exists - `platformConfig.wallet.cryptoCurrencies` classifies rails, it is not an
  // allowlist, so today any non-empty string is accepted and persisted.
  async setActiveCurrency(userId: User['id'], currency: string) {
    const updated = await this.drizzle.db
      .update(wallet)
      .set({ currency })
      .where(eq(wallet.userId, userId))
      .returning({ currency: wallet.currency });
    const record = updated[0];
    if (!record) {
      throw new WalletNotFoundError(userId);
    }
    return { activeCurrency: record.currency };
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
    } else {
      [preResolvedWallet] = await this.drizzle.db
        .select()
        .from(wallet)
        .where(eq(wallet.userId, userId));
    }

    const psp = await this.payment.processDeposit(amount, currency, { userId, provider });

    const { transactionId, replayed } = await this.drizzle.db.transaction(async (txn) => {
      let walletRecord = preResolvedWallet;
      if (!walletRecord) {
        [walletRecord] = await txn.select().from(wallet).where(eq(wallet.userId, userId));
      }
      if (!walletRecord) {
        walletRecord = findOneOrThrow(
          await txn.insert(wallet).values({ userId, currency }).returning(),
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
          direction: 'credit',
          rail: this.resolveRail(currency),
          providerName: provider,
          providerRefId: psp.externalId,
        },
      });

      if (!replayed) {
        await creditWalletBalance(txn, walletRecord.id, currency, amount);
      }

      return { transactionId: row.id, replayed };
    });

    if (!replayed) {
      this.events.emit('wallet.deposit.completed', {
        userId,
        playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
        amount,
        currency,
        transactionId,
      });
    }

    return { transactionId, status: 'completed' };
  }

  async manualAdjust({
    adminId,
    userId,
    direction,
    amount,
    currency,
    reason,
    idempotencyKey,
    ip,
    userAgent,
  }: {
    adminId: User['id'];
    userId: User['id'];
    direction: ManualAdjustmentDirection;
    amount: string;
    currency: string;
    reason: string;
    idempotencyKey: string;
  } & ClientMeta): Promise<TransactionResult> {
    const playerId = await this.identityReader.getPlayerIdByUserId(userId);
    if (!playerId) {
      throw new PlayerNotFoundError(userId);
    }

    const { result, emitted } = await this.drizzle.db.transaction(async (txn) => {
      let walletRecord = (
        await txn.select().from(wallet).where(eq(wallet.userId, userId)).for('update')
      ).at(0);
      if (!walletRecord) {
        if (direction === 'debit') {
          throw new InsufficientBalanceError('0', amount);
        }
        const [created] = await txn
          .insert(wallet)
          .values({ userId, currency })
          .onConflictDoNothing()
          .returning();
        walletRecord =
          created ??
          findOneOrThrow(
            await txn.select().from(wallet).where(eq(wallet.userId, userId)).for('update'),
            new WalletNotFoundError(userId),
          );
      }

      const existing = await this.findByIdempotencyKey(
        txn,
        walletRecord.id,
        namespacedIdempotencyKey(MANUAL_ADJUSTMENT_IDEMPOTENCY_NAMESPACE, idempotencyKey),
      );
      if (existing) {
        this.assertManualAdjustmentReplayMatches(existing, {
          adminId,
          direction,
          amount,
          currency,
          reason,
        });
        return { result: { transactionId: existing.id, status: existing.status }, emitted: false };
      }

      const { row, replayed } = await this.insertIdempotentTransaction(txn, {
        namespace: MANUAL_ADJUSTMENT_IDEMPOTENCY_NAMESPACE,
        walletId: walletRecord.id,
        rawIdempotencyKey: idempotencyKey,
        amount,
        currency,
        values: {
          walletId: walletRecord.id,
          type: direction === 'credit' ? 'manual_credit' : 'manual_debit',
          amount,
          currency,
          status: 'completed',
          direction,
          reviewedBy: adminId,
          reviewedAt: new Date(),
          reviewReason: reason,
        },
      });
      if (replayed) {
        this.assertManualAdjustmentReplayMatches(row, {
          adminId,
          direction,
          amount,
          currency,
          reason,
        });
        return { result: { transactionId: row.id, status: row.status }, emitted: false };
      }

      const balances =
        direction === 'credit'
          ? await creditWalletBalance(txn, walletRecord.id, currency, amount)
          : await debitWalletBalance(txn, walletRecord.id, currency, amount);
      const [balance] = balances;
      if (!balance) {
        throw new InsufficientBalanceError(
          await readWalletBalance(txn, walletRecord.id, currency),
          amount,
        );
      }
      // Derived from the row the update returned, never read separately beforehand. The
      // wallet row is locked here but the deposit credit path does not take that lock, so
      // a deposit can commit between a pre-read and this update - and `before` is going
      // into an append-only audit record that cannot be corrected later.
      const balanceBefore =
        direction === 'credit'
          ? moneySubtract(balance.amount, amount)
          : moneyAdd(balance.amount, amount);
      await this.audit.recordInTransaction(txn, {
        actorId: adminId,
        actorType: 'admin',
        action: 'wallet.manual_adjustment.created',
        resourceType: 'wallet_transaction',
        resourceId: row.id,
        before: { balance: balanceBefore, currency },
        after: {
          balance: balance.amount,
          currency,
          transactionId: row.id,
          direction,
          amount,
          reason,
        },
        ip,
        userAgent,
      });
      return { result: { transactionId: row.id, status: row.status }, emitted: true };
    });

    // Every other balance-mutating path on this service emits; without this one an admin
    // correction moves a real balance while responsible-gaming monitoring, analytics and
    // any operator subscriber see nothing at all.
    if (emitted) {
      this.events.emit('wallet.manual_adjustment.created', {
        userId,
        playerId,
        adminId,
        amount,
        currency,
        transactionId: result.transactionId,
        direction,
        reason,
        ip,
        userAgent,
      });
    }
    return result;
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

  // Replay comparison only (not a ledger write). moneyEquals avoids a false mismatch between
  // an unnormalized caller string (eg "10") and the DB's fixed-scale value ("10.00") while
  // staying exact - a float compare would let two amounts differing past the 15th digit pass.
  private assertReplayMatches(existing: WalletTransaction, amount: string, currency: string): void {
    if (
      !moneyEquals(existing.amount, amount) ||
      existing.currency.toUpperCase() !== currency.toUpperCase()
    ) {
      throw new IdempotencyKeyReuseError();
    }
  }

  private assertManualAdjustmentReplayMatches(
    existing: WalletTransaction,
    {
      adminId,
      direction,
      amount,
      currency,
      reason,
    }: {
      adminId: User['id'];
      direction: ManualAdjustmentDirection;
      amount: string;
      currency: string;
      reason: string;
    },
  ): void {
    if (
      existing.type !== (direction === 'credit' ? 'manual_credit' : 'manual_debit') ||
      existing.reviewedBy !== adminId ||
      existing.reviewReason !== reason
    ) {
      throw new IdempotencyKeyReuseError();
    }
    this.assertReplayMatches(existing, amount, currency);
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
      // `direction` is nullable on the column (historical rows predate it) but every
      // new insert must set it explicitly - narrowed to required+non-null here so a
      // caller that forgets it fails to typecheck instead of writing another NULL row.
      values: Omit<typeof walletTransaction.$inferInsert, 'idempotencyKey' | 'direction'> & {
        direction: ManualAdjustmentDirection;
      };
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
    network,
    idempotencyKey,
    destinationAddress,
    destinationTag,
    ip,
    userAgent,
  }: {
    userId: User['id'];
    amount: string;
    currency: string;
    network?: string;
    idempotencyKey?: string;
    destinationAddress?: string;
    destinationTag?: string;
  } & ClientMeta): Promise<TransactionResult> {
    await this.rateLimit(userId);
    await this.assertKycForWithdrawal(userId);
    if (this.resolveRail(currency) === 'crypto' && !destinationAddress) {
      throw new DestinationAddressRequiredError();
    }
    const assets = await this.assetsForCurrency(currency);
    const settlementNetwork = resolveWithdrawalNetwork(assets, currency, network);
    assertAboveMinimumWithdrawal(assets, amount, currency, settlementNetwork);
    const destinationWalletId = await this.requireWhitelistedWalletId(
      userId,
      currency,
      settlementNetwork,
      destinationAddress,
      destinationTag,
    );

    const { transactionId, status, replayed, walletId, rail } = await this.drizzle.db.transaction(
      async (txn) => {
        // FOR UPDATE serializes concurrent withdrawals against a double-debit TOCTOU under READ COMMITTED.
        const current = findOneOrThrow(
          await txn.select().from(wallet).where(eq(wallet.userId, userId)).for('update'),
          new WalletNotFoundError(userId),
        );
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
            direction: 'debit',
            rail: this.resolveRail(currency),
            network: settlementNetwork,
            destinationAddress: destinationAddress ?? null,
            destinationTag: destinationTag ?? null,
            destinationWalletId,
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

        const debited = await debitWithdrawableBalance(txn, current.id, currency, amount);
        if (debited.length !== 1) {
          const [available, locked] = await Promise.all([
            readWalletBalance(txn, current.id, currency),
            readLockedBonusAmount(txn, current.id, currency),
          ]);
          if (moneyToNumber(available) < moneyToNumber(amount)) {
            throw new InsufficientBalanceError(available, amount);
          }
          throw new BonusRolloverLockedError(locked);
        }

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
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
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
        playerId: summary?.playerId ?? null,
        username: summary?.username ?? '',
        amount: r.tx.amount,
        currency: r.tx.currency,
        network: r.tx.network,
        rail: r.tx.rail ?? null,
        status: r.tx.status,
        kycStatus: summary?.kycStatus ?? null,
        riskTags,
        requestedAt: r.tx.createdAt.toISOString(),
        destinationAddress: r.tx.destinationAddress,
        destinationTag: r.tx.destinationTag,
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
        destinationTag: tx.destinationTag,
        // The provider-side whitelisted destination for that address, when the bound adapter
        // whitelists at all. Absent for an address that predates whitelisting or was never in
        // the book, and such an adapter is expected to refuse rather than pay out to the raw
        // address - the whitelist is the control, so bypassing it would defeat the point.
        ...(tx.destinationWalletId ? { destinationWalletId: tx.destinationWalletId } : {}),
        // Pinned at request time; without it an adapter cannot tell ERC20 USDT from TRC20.
        network: tx.network,
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
        .set({
          providerName: await this.providerNameFor(tx.currency, tx.network),
          providerRefId: result.externalId,
        })
        .where(eq(walletTransaction.id, tx.id));
      return { transactionId: tx.id, status: 'processing' };
    }

    await this.drizzle.db
      .update(walletTransaction)
      .set({
        status: 'completed',
        providerName: await this.providerNameFor(tx.currency, tx.network),
        providerRefId: result.externalId,
      })
      .where(eq(walletTransaction.id, tx.id));
    this.events.emit('wallet.withdrawal.completed', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
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
      await creditWalletBalance(txn, tx.walletId, tx.currency, amount);
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
        playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
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

    const effectiveExcludeTags = threshold.config.excludeRiskFlags;

    const riskTags = await this.autoApprovalRiskTags(userId, effectiveExcludeTags);
    // null = exclusions configured but the lookup port is unavailable => fail closed.
    if (riskTags === null) {
      return null;
    }
    if (riskTags.some((t) => effectiveExcludeTags.includes(t))) {
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
      effectiveExcludeTags,
    };
  }

  private async resolveAutoThreshold(
    userId: User['id'],
    rail: WalletRail,
  ): Promise<{
    value: string;
    source: 'per-player' | 'global';
    config: WalletAutoWithdrawalConfig;
  } | null> {
    // Always read the global singleton first, even when a per-player override may end up
    // winning below - an unseeded install (missing row) must fail closed for EVERY player,
    // not just those without an override. getAutoWithdrawalConfig() throws when absent.
    const config = await this.getAutoWithdrawalConfig();
    const [rule] = await this.drizzle.db
      .select()
      .from(autoWithdrawalRule)
      .where(eq(autoWithdrawalRule.userId, userId));
    if (rule) {
      return { value: rule.threshold, source: 'per-player', config };
    }
    const global = rail === 'crypto' ? config.cryptoThreshold : config.fiatThreshold;
    return { value: global, source: 'global', config };
  }

  // The row always exists in a properly-seeded install (seeded once) - a
  // missing row is an unexpected failure mode on the READ path, not a normal
  // "unconfigured" state, so this throws rather than silently defaulting.
  // maybeAutoApprove's outer try/catch handles that thrown error the same as any
  // other unexpected error: fail closed to pending.
  async getAutoWithdrawalConfig(): Promise<WalletAutoWithdrawalConfig> {
    const config = await this.getAutoWithdrawalConfigOrNull();
    if (!config) {
      throw new AutoWithdrawalConfigNotFoundError('global');
    }
    return config;
  }

  // Non-throwing variant for callers that need to tell "missing" from "found"
  // without a try/catch (eg the router's audit `before` read).
  async getAutoWithdrawalConfigOrNull(): Promise<WalletAutoWithdrawalConfig | null> {
    const [row] = await this.drizzle.db
      .select()
      .from(walletAutoWithdrawalConfig)
      .where(eq(walletAutoWithdrawalConfig.singletonKey, 'global'));
    return row ? toAutoWithdrawalConfigDto(row) : null;
  }

  // Upsert, not a plain UPDATE: the WRITE path lets a Super Admin self-heal a
  // missing singleton row (eg an install that skipped the seed step) through the
  // existing route with zero new surface. The READ path (getAutoWithdrawalConfig,
  // resolveAutoThreshold) still throws on a missing row and stays fail-closed -
  // a withdrawal must never silently create config.
  //
  // Update + audit write run in one transaction: an audit-write failure must roll back
  // the threshold change too, or the config could change with no audit trail.
  async setAutoWithdrawalConfig(
    adminId: User['id'],
    {
      fiatThreshold,
      cryptoThreshold,
      excludeRiskFlags,
    }: { fiatThreshold: string; cryptoThreshold: string; excludeRiskFlags: TagKey[] },
    meta?: ClientMeta,
  ): Promise<WalletAutoWithdrawalConfig> {
    return this.drizzle.db.transaction(async (txn) => {
      const [before] = await txn
        .select()
        .from(walletAutoWithdrawalConfig)
        .where(eq(walletAutoWithdrawalConfig.singletonKey, 'global'));
      const rows = await txn
        .insert(walletAutoWithdrawalConfig)
        .values({
          singletonKey: 'global',
          fiatThreshold,
          cryptoThreshold,
          excludeRiskFlags,
          updatedBy: adminId,
        })
        .onConflictDoUpdate({
          target: walletAutoWithdrawalConfig.singletonKey,
          set: { fiatThreshold, cryptoThreshold, excludeRiskFlags, updatedBy: adminId },
        })
        .returning();
      const config = toAutoWithdrawalConfigDto(
        findOneOrThrow(rows, new AutoWithdrawalConfigNotFoundError('global')),
      );
      await this.audit.recordInTransaction(txn, {
        actorId: adminId,
        actorType: 'admin',
        action: 'wallet.auto_withdrawal_config.set',
        resourceType: 'auto_withdrawal_config',
        resourceId: config.id,
        before: before
          ? {
              fiatThreshold: before.fiatThreshold,
              cryptoThreshold: before.cryptoThreshold,
              excludeRiskFlags: before.excludeRiskFlags,
            }
          : null,
        after: {
          fiatThreshold: config.fiatThreshold,
          cryptoThreshold: config.cryptoThreshold,
          excludeRiskFlags: config.excludeRiskFlags,
        },
        ...meta,
      });
      return config;
    });
  }

  async getBonusRolloverStatus(
    userId: User['id'],
    status: BonusCreditStatus = 'active',
  ): Promise<{ credits: BonusCredit[] }> {
    const rows = await this.drizzle.db
      .select()
      .from(walletBonusCredit)
      .where(and(eq(walletBonusCredit.userId, userId), eq(walletBonusCredit.status, status)))
      .orderBy(desc(walletBonusCredit.createdAt))
      .limit(50);
    return { credits: rows.map(toBonusCreditDto) };
  }

  async getBonusRolloverConfig(): Promise<BonusRolloverConfig> {
    const config = await this.getBonusRolloverConfigOrNull();
    if (!config) {
      throw new BonusRolloverConfigNotFoundError('global');
    }
    return config;
  }

  async getBonusRolloverConfigOrNull(): Promise<BonusRolloverConfig | null> {
    const [row] = await this.drizzle.db
      .select()
      .from(walletBonusRolloverConfig)
      .where(eq(walletBonusRolloverConfig.singletonKey, 'global'));
    return row ? toBonusRolloverConfigDto(row) : null;
  }

  async setBonusRolloverConfig(
    adminId: User['id'],
    { multiplier }: { multiplier: string },
    meta?: ClientMeta,
  ): Promise<BonusRolloverConfig> {
    return this.drizzle.db.transaction(async (txn) => {
      const [before] = await txn
        .select()
        .from(walletBonusRolloverConfig)
        .where(eq(walletBonusRolloverConfig.singletonKey, 'global'));
      const rows = await txn
        .insert(walletBonusRolloverConfig)
        .values({ singletonKey: 'global', multiplier, updatedBy: adminId })
        .onConflictDoUpdate({
          target: walletBonusRolloverConfig.singletonKey,
          set: { multiplier, updatedBy: adminId, updatedAt: new Date() },
        })
        .returning();
      const config = toBonusRolloverConfigDto(
        findOneOrThrow(rows, new BonusRolloverConfigNotFoundError('global')),
      );
      await this.audit.recordInTransaction(txn, {
        actorId: adminId,
        actorType: 'admin',
        action: 'wallet.bonus_rollover_config.set',
        resourceType: 'bonus_rollover_config',
        resourceId: config.id,
        before: before ? { multiplier: before.multiplier } : null,
        after: { multiplier: config.multiplier },
        ...meta,
      });
      return config;
    });
  }

  async listWalletAssets(): Promise<WalletAsset[]> {
    const rows = await this.drizzle.db
      .select()
      .from(walletAsset)
      .orderBy(asc(walletAsset.currency), asc(walletAsset.network));
    return rows.map(toWalletAssetDto);
  }

  listEnabledWalletAssets(): Promise<PublicWalletAsset[]> {
    return this.drizzle.db
      .select(PUBLIC_ASSET_COLUMNS)
      .from(walletAsset)
      .where(or(eq(walletAsset.depositEnabled, true), eq(walletAsset.withdrawalEnabled, true)))
      .orderBy(asc(walletAsset.currency), asc(walletAsset.network));
  }

  async getWalletAsset(currency: string, network: string): Promise<WalletAsset | null> {
    const [row] = await this.drizzle.db
      .select()
      .from(walletAsset)
      .where(and(eq(walletAsset.currency, currency), eq(walletAsset.network, network)));
    return row ? toWalletAssetDto(row) : null;
  }

  // The catalog is operator-editable, so an admin can name a pair the bound vendor has
  // never heard of. Reject at write time rather than at a player's deposit request.
  private assertAdapterSupports(currency: string, network: string) {
    if (this.payment.supportsAsset && !this.payment.supportsAsset(currency, network)) {
      throw new WalletAssetUnsupportedError();
    }
  }

  // Same discipline as assertAdapterSupports, for the provider key itself: an
  // unvalidated typo silently falls back to the default adapter, which means eg a
  // crypto payout attempted through a PSP. Undefined (the default binding) always passes.
  private assertProviderNameValid(providerName: string | undefined) {
    if (providerName !== undefined && !this.paymentProviders.names().includes(providerName)) {
      throw new WalletAssetUnknownProviderError();
    }
  }

  async createWalletAsset(
    adminId: User['id'],
    input: CreateWalletAssetInput,
    meta?: ClientMeta,
  ): Promise<WalletAsset> {
    this.assertAdapterSupports(input.currency, input.network);
    this.assertProviderNameValid(input.providerName);
    return this.drizzle.db.transaction(async (txn) => {
      const rows = await txn.insert(walletAsset).values(input).onConflictDoNothing().returning();
      // Empty => the (currency, network) unique index rejected it.
      const asset = toWalletAssetDto(findOneOrThrow(rows, new WalletAssetAlreadyExistsError()));
      await this.audit.recordInTransaction(txn, {
        actorId: adminId,
        actorType: 'admin',
        action: 'wallet.wallet_asset.created',
        resourceType: 'wallet_asset',
        resourceId: asset.id,
        before: null,
        after: asset,
        ...meta,
      });
      return asset;
    });
  }

  // Deliberately touches only the catalog row: a withdrawal already pending or processing
  // in this currency keeps its own terms and is never cancelled by disabling the pair.
  async updateWalletAsset(
    adminId: User['id'],
    { currency, network, ...changes }: UpdateWalletAssetInput,
    meta?: ClientMeta,
  ): Promise<WalletAsset> {
    if (changes.providerAssetId !== undefined) {
      this.assertAdapterSupports(currency, network);
    }
    return this.drizzle.db.transaction(async (txn) => {
      const [before] = await txn
        .select()
        .from(walletAsset)
        .where(and(eq(walletAsset.currency, currency), eq(walletAsset.network, network)));
      if (!before) {
        throw new WalletAssetNotFoundError(`${currency}/${network}`);
      }
      const rows = await txn
        .update(walletAsset)
        .set(changes)
        .where(and(eq(walletAsset.currency, currency), eq(walletAsset.network, network)))
        .returning();
      const asset = toWalletAssetDto(
        findOneOrThrow(rows, new WalletAssetNotFoundError(`${currency}/${network}`)),
      );
      await this.audit.recordInTransaction(txn, {
        actorId: adminId,
        actorType: 'admin',
        action: 'wallet.wallet_asset.updated',
        resourceType: 'wallet_asset',
        resourceId: asset.id,
        before: toWalletAssetDto(before),
        after: asset,
        ...meta,
      });
      return asset;
    });
  }

  async deleteWalletAsset(
    adminId: User['id'],
    currency: string,
    network: string,
    meta?: ClientMeta,
  ): Promise<boolean> {
    return this.drizzle.db.transaction(async (txn) => {
      const [before] = await txn
        .select()
        .from(walletAsset)
        .where(and(eq(walletAsset.currency, currency), eq(walletAsset.network, network)));
      if (!before) {
        return false;
      }
      // wallet_balance is keyed by currency only (no network column), so this guard is
      // necessarily currency-wide: removing one network of a currency players still hold
      // is blocked even if their balance arrived over another network. Fails safe.
      const [held] = await txn
        .select({ n: count() })
        .from(walletBalance)
        .where(and(eq(walletBalance.currency, currency), sql`${walletBalance.amount} > 0`));
      if ((held?.n ?? 0) > 0) {
        throw new WalletAssetInUseError();
      }
      // Renaming a pair is a delete plus a create (the (currency, network) key AND
      // providerName are immutable), so this delete is the only way providerName ever
      // effectively changes. Block it while a pending/processing transaction exists for
      // this exact (currency, network) pair - otherwise the vendor reference an in-flight
      // payout is settling through gets rewritten out from under it.
      const [inFlight] = await txn
        .select({ n: count() })
        .from(walletTransaction)
        .where(
          and(
            eq(walletTransaction.currency, currency),
            eq(walletTransaction.network, network),
            inArray(walletTransaction.status, ['pending', 'processing']),
          ),
        );
      if ((inFlight?.n ?? 0) > 0) {
        throw new WalletAssetHasInFlightTransactionsError();
      }
      await txn
        .delete(walletAsset)
        .where(and(eq(walletAsset.currency, currency), eq(walletAsset.network, network)));
      await this.audit.recordInTransaction(txn, {
        actorId: adminId,
        actorType: 'admin',
        action: 'wallet.wallet_asset.deleted',
        resourceType: 'wallet_asset',
        resourceId: before.id,
        before: toWalletAssetDto(before),
        after: null,
        ...meta,
      });
      return true;
    });
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

      await creditWalletBalance(txn, updated.walletId, updated.currency, updated.amount);

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
    includeInternal = false,
  }: PaginationOptions<
    { userId: User['id']; includeInternal?: boolean },
    WalletTransactionSortBy
  >) {
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
        network: tx.network,
        status: tx.status,
        direction: tx.direction,
        createdAt: tx.createdAt.toISOString(),
        reviewedBy: includeInternal ? tx.reviewedBy : null,
        reviewedAt: includeInternal ? (tx.reviewedAt?.toISOString() ?? null) : null,
        reviewReason: includeInternal ? tx.reviewReason : null,
      })),
      total: Number(n),
      page,
      limit,
    };
  }

  async getOrCreateDepositAddress(
    userId: User['id'],
    currency: string,
    network?: string,
  ): Promise<DepositAddressResult> {
    const existing = await this.findDepositAddress(userId, currency, network);
    if (existing) {
      return toDepositAddressResult(existing);
    }
    if (!this.payment.issueDepositAddress) {
      throw new DepositAddressUnsupportedError();
    }
    const issued = await this.payment.issueDepositAddress(userId, currency, network);

    const [row] = await this.drizzle.db
      .insert(walletDepositAddress)
      .values({
        userId,
        currency,
        network: network ?? null,
        address: issued.address,
        tag: issued.tag ?? null,
        providerName: await this.providerNameFor(currency, network ?? null),
      })
      .onConflictDoNothing()
      .returning();
    if (row) {
      return toDepositAddressResult(row);
    }
    const winner = await this.findDepositAddress(userId, currency, network);
    if (!winner) {
      throw new Error(
        `wallet deposit address: idempotency conflict but no row found (userId=${userId}, currency=${currency}, network=${network ?? 'none'})`,
      );
    }
    return toDepositAddressResult(winner);
  }

  /**
   * `providerName` is the vendor the webhook route already resolved (verifier + adapter
   * came from the same registry entry) - it is only used to label a finding when this
   * deposit can't be attributed, never to look anything up. Defaults to the single
   * default binding for callers (tests, a poller with no named provider) that don't care.
   */
  async creditDepositByAddress(
    event: Extract<PaymentWebhookEvent, { kind: 'deposit' }>,
    providerName: string = DEFAULT_PAYMENT_PROVIDER,
  ): Promise<void> {
    const depositAddress = await this.findDepositAddressByAddress(event);
    if (!depositAddress) {
      // A known vendor defect hits this live: a token deposit reported under a sibling
      // token's asset id never resolves to a row. Never let it survive only as a log
      // line - file a finding so an operator can attribute and manually credit it.
      logger.warn(
        { address: event.address, network: event.network, tag: event.tag },
        'payment webhook: no wallet_deposit_address for inbound deposit',
      );
      await recordReconciliationFinding(this.drizzle.db, {
        runId: LIVE_WEBHOOK_RUN_ID,
        providerName,
        kind: 'unattributed_deposit',
        currency: event.currency,
        network: event.network ?? null,
        amount: event.amount,
        address: event.address,
        tag: event.tag ?? null,
        txHash: event.txHash,
        externalId: event.externalId,
        detail: 'no wallet_deposit_address matched this address/network/tag',
      });
      return;
    }
    if (
      event.network === undefined &&
      event.currency.toUpperCase() !== depositAddress.currency.toUpperCase()
    ) {
      // Same "do not silently drop" discipline as the no-address branch above - this is
      // the push-path counterpart to the poll-path's currency_mismatch finding.
      logger.warn(
        {
          address: event.address,
          eventCurrency: event.currency,
          addressCurrency: depositAddress.currency,
        },
        'payment webhook: currency mismatch for inbound deposit',
      );
      await recordReconciliationFinding(this.drizzle.db, {
        runId: LIVE_WEBHOOK_RUN_ID,
        providerName: depositAddress.providerName,
        kind: 'currency_mismatch',
        currency: event.currency,
        network: event.network ?? depositAddress.network,
        amount: event.amount,
        address: event.address,
        tag: event.tag ?? null,
        txHash: event.txHash,
        externalId: event.externalId,
        detail: `currency mismatch: event reported ${event.currency}, address issued for ${depositAddress.currency}`,
      });
      return;
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
            .values({ userId: depositAddress.userId, currency: event.currency })
            .returning(),
          new WalletNotFoundError(depositAddress.userId),
        );
      }

      const [inserted] = await txn
        .insert(walletTransaction)
        .values({
          walletId: walletRecord.id,
          type: 'deposit',
          amount: event.amount,
          currency: event.currency,
          status: 'completed',
          direction: 'credit',
          rail: this.resolveRail(event.currency),
          // Prefer the chain the vendor reported; fall back to the one the address was
          // issued on, which is the only network an address-only webhook can imply.
          network: event.network ?? depositAddress.network,
          providerName: depositAddress.providerName,
          providerRefId: event.externalId,
          destinationAddress: event.address,
          txHash: event.txHash,
        })
        .onConflictDoNothing()
        .returning();

      if (inserted) {
        await creditWalletBalance(txn, walletRecord.id, event.currency, event.amount);
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
        playerId: await this.identityReader.getPlayerIdByUserIdSafe(depositAddress.userId),
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

  private async findDepositAddress(userId: User['id'], currency: string, network?: string) {
    const [row] = await this.drizzle.db
      .select()
      .from(walletDepositAddress)
      .where(
        and(
          eq(walletDepositAddress.userId, userId),
          eq(walletDepositAddress.currency, currency),
          network === undefined
            ? isNull(walletDepositAddress.network)
            : eq(walletDepositAddress.network, network),
        ),
      );
    return row;
  }

  private async findDepositAddressByAddress({
    address,
    network,
    tag,
  }: Extract<PaymentWebhookEvent, { kind: 'deposit' }>) {
    const rows = await this.drizzle.db
      .select()
      .from(walletDepositAddress)
      .where(
        and(
          eq(walletDepositAddress.address, address),
          tag === undefined ? isNull(walletDepositAddress.tag) : eq(walletDepositAddress.tag, tag),
          network === undefined
            ? undefined
            : or(eq(walletDepositAddress.network, network), isNull(walletDepositAddress.network)),
        ),
      );

    const owners = new Set(rows.map((row) => row.userId));
    if (owners.size > 1) {
      throw new AmbiguousDepositAddressError(address, network);
    }
    return rows.find((row) => row.network === network) ?? rows[0];
  }

  /**
   * The player's own payout address book. Every method here is scoped on `userId` - a
   * saved address is personal data with no admin read path, so there is
   * deliberately no variant of these that takes an arbitrary user id.
   */
  async listWithdrawalAddresses(userId: Uuid, currency?: string): Promise<WithdrawalAddress[]> {
    const rows = await this.drizzle.db
      .select()
      .from(walletWithdrawalAddress)
      .where(
        and(
          eq(walletWithdrawalAddress.userId, userId),
          currency === undefined ? undefined : eq(walletWithdrawalAddress.currency, currency),
        ),
      )
      .orderBy(desc(walletWithdrawalAddress.createdAt));
    return rows.map(toWithdrawalAddressDto);
  }

  async createWithdrawalAddress(
    userId: Uuid,
    input: CreateWithdrawalAddressInput,
    meta?: Partial<ClientMeta>,
  ): Promise<WithdrawalAddress> {
    // Shares the wallet mutation budget with deposit/withdraw: the row cap alone does
    // not bound writes, since deleting frees a slot and lets a client churn forever.
    await this.rateLimit(userId);
    // ponytail: count-then-insert, so N concurrent creates can land N over the cap.
    // Move to an insert...where (select count) < limit if that ever matters.
    const [existing] = await this.drizzle.db
      .select({ total: count() })
      .from(walletWithdrawalAddress)
      .where(eq(walletWithdrawalAddress.userId, userId));
    if ((existing?.total ?? 0) >= WITHDRAWAL_ADDRESS_LIMIT) {
      throw new WithdrawalAddressLimitReachedError(WITHDRAWAL_ADDRESS_LIMIT);
    }

    // Registered with the custody provider BEFORE the row exists, so a rejected or unreachable
    // provider leaves no saved address the player would believe they can withdraw to. The port
    // is required to be idempotent, so the conflict path below cannot orphan a destination.
    const whitelisted = await this.whitelistWithdrawalAddress(userId, input);

    // onConflictDoNothing turns the unique index into a domain conflict rather than a
    // 500 - a double-submitted form is a 409, not an incident.
    const [row] = await this.drizzle.db
      .insert(walletWithdrawalAddress)
      .values({ userId, ...input, ...whitelisted })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      throw new WithdrawalAddressAlreadyExistsError();
    }

    await this.audit.record({
      actorId: userId,
      actorType: 'player',
      action: 'wallet.withdrawal_address.created',
      resourceType: 'wallet_withdrawal_address',
      resourceId: row.id,
      // The address string is deliberately absent: the audit log is admin-readable and
      // a player's saved addresses are not. The row id is enough to correlate.
      after: { label: row.label, currency: row.currency, network: row.network },
      ...meta,
    });
    return toWithdrawalAddressDto(row);
  }

  /**
   * Refuses a payout to a destination the provider has not approved. A no-op for an adapter that
   * does not whitelist, and for a fiat rail, which has no address at all.
   *
   * The tag is matched as strictly as the address. On a tag chain one exchange address is shared
   * by every account behind it, so an address-only check would let a player whitelist their own
   * account at that exchange and then pay out to a stranger's tag at the same address - an
   * auto-approved withdrawal would do it with nobody looking.
   */
  private async requireWhitelistedWalletId(
    userId: Uuid,
    currency: string,
    network: string | null,
    destinationAddress: string | undefined,
    destinationTag: string | undefined,
  ): Promise<string | null> {
    if (!this.payment.whitelistWithdrawalAddress || !destinationAddress) {
      return null;
    }
    const walletId = await this.whitelistedWalletId(
      userId,
      currency,
      network,
      destinationAddress,
      destinationTag,
    );
    if (!walletId) {
      throw new DestinationAddressNotWhitelistedError();
    }
    return walletId;
  }

  /**
   * The approved destination saved for this (address, tag) pair, or null. Matched on the pair
   * itself rather than an id on the transaction, because a withdrawal is requested by address
   * and may name one the player never saved. An absent tag matches only a row saved without
   * one: a tagged payout against an untagged whitelist row is a different beneficiary.
   */
  private async whitelistedWalletId(
    userId: Uuid,
    currency: string,
    network: string | null,
    address: string | null | undefined,
    destinationTag: string | null | undefined,
  ): Promise<string | null> {
    if (!this.payment.whitelistWithdrawalAddress || !address) {
      return null;
    }
    const providerName = await this.providerNameFor(currency, network);
    const [row] = await this.drizzle.db
      .select({
        id: walletWithdrawalAddress.id,
        network: walletWithdrawalAddress.network,
        destinationTag: walletWithdrawalAddress.destinationTag,
        providerName: walletWithdrawalAddress.providerName,
        providerWalletId: walletWithdrawalAddress.providerWalletId,
      })
      .from(walletWithdrawalAddress)
      .where(
        and(
          eq(walletWithdrawalAddress.userId, userId),
          eq(walletWithdrawalAddress.currency, currency),
          eq(walletWithdrawalAddress.address, address),
          destinationTag
            ? eq(walletWithdrawalAddress.destinationTag, destinationTag)
            : isNull(walletWithdrawalAddress.destinationTag),
          ...(network ? [eq(walletWithdrawalAddress.network, network)] : []),
        ),
      )
      .limit(1);
    if (!row) {
      return null;
    }
    // An id minted by a different provider names nothing in the current one, and a row
    // saved while no whitelisting adapter was bound has no id at all. Both re-register
    // with the provider that will actually settle, rather than failing a payout on a
    // saved address the player cannot fix themselves.
    if (row.providerWalletId && row.providerName === providerName) {
      return row.providerWalletId;
    }
    const { providerWalletId } = await this.payment.whitelistWithdrawalAddress({
      userId,
      currency,
      network: row.network,
      address,
      ...(row.destinationTag ? { destinationTag: row.destinationTag } : {}),
    });
    await this.drizzle.db
      .update(walletWithdrawalAddress)
      .set({ providerName, providerWalletId })
      .where(eq(walletWithdrawalAddress.id, row.id));
    return providerWalletId;
  }

  /**
   * Delegates to the bound payment adapter when it whitelists destinations, and returns nothing
   * to store when it does not. A vendor failure propagates rather than being swallowed: saving
   * the address anyway would produce a row that looks usable and fails only once the player has
   * committed to a payout.
   */
  private async whitelistWithdrawalAddress(
    userId: Uuid,
    input: CreateWithdrawalAddressInput,
  ): Promise<{ providerName: string; providerWalletId: string } | Record<string, never>> {
    if (!this.payment.whitelistWithdrawalAddress) {
      return {};
    }
    const { providerWalletId } = await this.payment.whitelistWithdrawalAddress({
      userId,
      currency: input.currency,
      network: input.network,
      address: input.address,
      ...(input.destinationTag ? { destinationTag: input.destinationTag } : {}),
    });
    return {
      providerName: await this.providerNameFor(input.currency, input.network),
      providerWalletId,
    };
  }

  /** False when the row does not exist OR belongs to someone else - the caller cannot
   * tell the two apart, which is what stops the id space being probed. */
  async deleteWithdrawalAddress(
    userId: Uuid,
    id: WithdrawalAddress['id'],
    meta?: Partial<ClientMeta>,
  ): Promise<boolean> {
    await this.rateLimit(userId);
    const [row] = await this.drizzle.db
      .delete(walletWithdrawalAddress)
      .where(and(eq(walletWithdrawalAddress.id, id), eq(walletWithdrawalAddress.userId, userId)))
      .returning();
    if (!row) {
      return false;
    }

    await this.audit.record({
      actorId: userId,
      actorType: 'player',
      action: 'wallet.withdrawal_address.deleted',
      resourceType: 'wallet_withdrawal_address',
      resourceId: row.id,
      before: { label: row.label, currency: row.currency, network: row.network },
      ...meta,
    });
    return true;
  }
}
