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
  isPositiveMoney,
  mapConcurrent,
  moneyEquals,
  moneyAdd,
  moneyCompare,
  moneySubtract,
  moneyScaleBy,
  escapeLike,
} from '@openora/core/server';
import {
  normalizeKycStatus,
  UuidSchema,
  RgLimitExceededError,
  DEFAULT_PAYMENT_PROVIDER,
  PaymentRejectedError,
  type PaymentAdapter,
  type PaymentProviderRegistry,
  type PaymentWebhookEvent,
  type AdminUserDirectory,
  type PlatformConfig,
  resolvePromoConfig,
  type KycStatus,
  type RateLimiterAdapter,
  type RateLimitKey,
  MoneyAmountSchema,
  type WalletDepositStatusEventStatus,
  type WalletRail,
  railFor as sharedRailFor,
  resolveExchangeRatePivot,
  resolveWalletReferenceCurrency,
  resolveDisplayCurrencies,
  type Player,
  type PlayerTags,
  type RgLimitsPort,
  type KycWithdrawalPolicy,
  type MailDispatchPort,
  type WithdrawalSecurity,
  type DepositHoldPolicy,
  type DepositAdmissionPolicy,
  type PlayEligibilityPort,
  DepositRefusedError,
  type ExchangeRateReader,
  type AuditWritePort,
  type TagKey,
  WITHDRAWAL_LOCK_TAG,
  type User,
  type IdentityReader,
  type ClientMeta,
  type Uuid,
  type PaginationOptions,
  type WalletProviderRef,
  type ActionExecutionContext,
  type WalletTransactionType,
  type WalletTransactionStatus,
  type WithdrawalRequeueReason,
  type BonusGrantLedgerReader,
  type BonusDepositCommands,
  type DomainEventPayload,
  type BonusFundLockCommands,
  type LockedFunds,
  type BonusLifecycleCommands,
  wagerProductOfProviderName,
  wagerProductProviderPrefix,
  withTurnoverLock,
} from '@openora/core/contracts';
import {
  eq,
  asc,
  desc,
  sql,
  and,
  gte,
  lte,
  count,
  inArray,
  notInArray,
  isNull,
  or,
  gt,
  lt,
  notExists,
  type SQL,
} from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { TurnoverService } from './turnover.service.js';
import {
  wallet,
  walletBalance,
  walletTransaction,
  autoWithdrawalRule,
  walletAutoWithdrawalConfig,
  walletDepositAddress,
  walletDepositStatusEvent,
  walletWithdrawalAddress,
  walletAsset,
  walletOnRampOrder,
  walletWithdrawalHold,
  type Wallet,
  type WalletDepositAddress,
  type WalletDepositStatusEvent,
  type WalletTransaction,
  type AutoWithdrawalRule as AutoWithdrawalRuleRow,
  type WalletAutoWithdrawalConfig as WalletAutoWithdrawalConfigRow,
  type WalletAssetRow,
  type WalletWithdrawalAddressRow,
} from '../schema/index.js';
import {
  OUT_OF_CYCLE_RUN_ID,
  isRefundedDeposit,
  lockVendorDeposit,
  recordReconciliationFinding,
  recordReconciliationFindingInTransaction,
  rgDecisionForLandedCredit,
} from './reconciliation-finding.service.js';
import type {
  TransactionResult,
  WithdrawalQueueItem,
  WithdrawalQueueFilter,
  WithdrawalQueueSummary,
  WithdrawalQueueSummaryFilter,
  AutoWithdrawalRule,
  WalletAutoWithdrawalConfig,
  WalletTransactionSortBy,
  WalletTransactionListQuery,
  WalletAsset,
  PublicWalletAsset,
  CreateWalletAssetInput,
  UpdateWalletAssetInput,
  ManualAdjustmentDirection,
  WithdrawalAddress,
  CreateWithdrawalAddressInput,
  WalletReferenceConversion,
  QueuedWithdrawalStatus,
  WithdrawalRiskTag,
  WithdrawalsQueue,
  WithdrawalsQueueInput,
} from '../contract/index.js';
import {
  OPEN_WITHDRAWALS_LIMIT,
  QUEUED_WITHDRAWAL_STATUSES,
  WITHDRAWAL_QUEUE_MAX_CURRENCIES,
} from '../contract/index.js';

const logger = createLogger('wallet');

function withdrawalAuditSubject(
  playerId: Player['id'] | null,
  transactionId: WalletTransaction['id'],
) {
  return playerId
    ? { resourceType: 'player', resourceId: playerId }
    : { resourceType: 'withdrawal', resourceId: transactionId };
}

export const WalletNotFoundError = makeNotFoundError('Wallet');
export const WithdrawalNotFoundError = makeNotFoundError('Withdrawal');
export const AutoWithdrawalConfigNotFoundError = makeNotFoundError('AutoWithdrawalConfig');
export const PlayerNotFoundError = makeNotFoundError('Player');

export const InsufficientBalanceError = createDomainError<[available: string, requested: string]>(
  'InsufficientBalanceError',
  (available, requested) => `Insufficient balance: available ${available}, requested ${requested}`,
);

export const WalletReferenceRateUnavailableError = createDomainError<
  [currency: string, referenceCurrency: string]
>(
  'WalletReferenceRateUnavailableError',
  (currency, referenceCurrency) =>
    `no fresh ${currency}/${referenceCurrency} exchange rate to record this transaction's reference value`,
);

export const UnsupportedAmountCurrencyError = createDomainError<[currency: string]>(
  'UnsupportedAmountCurrencyError',
  (currency) => `Currency is not offered by this operator: ${currency}`,
);

export const WithdrawalNotPendingError = makeConflictError(
  'WithdrawalNotPendingError',
  'Withdrawal is not pending and cannot be reviewed',
);

export const KycRequiredError = makeConflictError(
  'KycRequiredError',
  'KYC verification required before withdrawal',
);

export const WithdrawalLockedError = makeConflictError(
  'WithdrawalLockedError',
  'Withdrawals are on hold for this account. Please contact support',
  { reason: 'withdrawal_locked' },
);

export const WithdrawalHeldError = makeConflictError(
  'WithdrawalHeldError',
  'Withdrawals are on hold for this account. Please contact support',
  { reason: 'withdrawal_held' },
);
export class WithdrawalPinRequiredError extends Error {
  readonly data = { reason: 'withdrawal_pin_required' };
  constructor() {
    super('Enter your Withdrawal PIN to confirm');
    this.name = 'WithdrawalPinRequiredError';
  }
}

export class WithdrawalPinIncorrectError extends Error {
  readonly data: { reason: string; attemptsLeft: number };
  constructor(attemptsLeft: number) {
    super(`Incorrect PIN. ${attemptsLeft} attempts left`);
    this.name = 'WithdrawalPinIncorrectError';
    this.data = { reason: 'withdrawal_pin_incorrect', attemptsLeft };
  }
}

export class WithdrawalPinLockedError extends Error {
  readonly data: { reason: string; lockedUntil: string };
  constructor(lockedUntil: Date) {
    super('Too many incorrect attempts. Withdrawals are locked for 30 minutes');
    this.name = 'WithdrawalPinLockedError';
    this.data = { reason: 'withdrawal_pin_locked', lockedUntil: lockedUntil.toISOString() };
  }
}

export class DestinationAddressCoolingDownError extends Error {
  readonly data: { reason: string; usableFrom?: string };
  constructor(usableFrom: Date | null) {
    super(
      usableFrom
        ? `This address can be used for withdrawals from ${usableFrom.toISOString()}`
        : 'Save this address first. A new address can be used for withdrawals after 24 hours',
    );
    this.name = 'DestinationAddressCoolingDownError';
    this.data = usableFrom
      ? { reason: 'withdrawal_address_cooling_down', usableFrom: usableFrom.toISOString() }
      : { reason: 'withdrawal_address_not_saved' };
  }
}

export const WithdrawalAmountNotAboveFeeError = createDomainError<
  [amount: string, fee: string, currency: string]
>(
  'WithdrawalAmountNotAboveFeeError',
  (amount, fee, currency) =>
    `Withdrawal of ${amount} ${currency} does not exceed the ${fee} ${currency} network fee`,
);

export const WithdrawalPrecisionError = createDomainError<
  [amount: string, currency: string, network: string, decimals: number]
>(
  'WithdrawalPrecisionError',
  (amount, currency, network, decimals) =>
    `${amount} ${currency} has more than ${decimals} decimal places, the most ${network} can pay out`,
);

export const IdempotencyKeyReuseError = makeConflictError(
  'IdempotencyKeyReuseError',
  'Idempotency key was already used with a different amount',
);

export const HeldDepositNotFoundError = makeConflictError(
  'HeldDepositNotFoundError',
  'The deposit is not on hold and cannot be released or refunded',
);

export const DepositStillHeldError = createDomainError<[reason: string]>(
  'DepositStillHeldError',
  (reason) => `The deposit policy still holds this deposit: ${reason}`,
);

export const DepositAlreadyOnLedgerError = makeConflictError(
  'DepositAlreadyOnLedgerError',
  'This deposit is already on the ledger and cannot be credited or refunded by hand',
);

export const DepositAddressUnsupportedError = makeConflictError(
  'DepositAddressUnsupportedError',
  'The bound payment adapter does not support address-based deposits',
);

export const DestinationAddressRequiredError = makeConflictError(
  'DestinationAddressRequiredError',
  'A destination address is required for a crypto-rail withdrawal',
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
  { code: 'WALLET_ASSET_BALANCE_HELD' },
);

export const WalletAssetHasIssuedAddressesError = makeConflictError(
  'WalletAssetHasIssuedAddressesError',
  'A deposit address was already issued for this currency and network',
  { code: 'WALLET_ASSET_ADDRESS_ISSUED' },
);

export const WalletAssetUnknownProviderError = makeConflictError(
  'WalletAssetUnknownProviderError',
  'providerName is not a registered payment provider',
);

export const WalletAssetHasInFlightTransactionsError = makeConflictError(
  'WalletAssetHasInFlightTransactionsError',
  'A pending, on-hold or processing transaction exists for this currency and network',
  { code: 'WALLET_ASSET_TRANSACTION_IN_FLIGHT' },
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

export const DepositDisabledError = createDomainError(
  'DepositDisabledError',
  (currency, network) =>
    network
      ? `Deposits are disabled for ${currency} on ${network}`
      : `Deposits are disabled for ${currency} on every configured network`,
);

export const BelowMinimumDepositError = createDomainError(
  'BelowMinimumDepositError',
  (amount, minimum, currency, network) =>
    `Deposit of ${amount} ${currency} on ${network} is below the ${minimum} ${currency} minimum`,
);

const KYC_PASS_STATUSES: ReadonlySet<KycStatus> = new Set(['approved', 'manually_overridden']);

const isKycPassed = (status: KycStatus | null) =>
  status !== null && KYC_PASS_STATUSES.has(normalizeKycStatus(status));

const MalformedDepositEventError = createDomainError<[externalId: string]>(
  'MalformedDepositEventError',
  (externalId) => `Deposit event ${externalId || '(empty id)'} carries no usable amount or id`,
);

const AmbiguousDepositAddressError = createDomainError(
  'AmbiguousDepositAddressError',
  (address, network) =>
    `Deposit address ${address} on ${network ?? 'an unknown network'} is issued to more than one user`,
);

const WITHDRAWAL_ADDRESS_LIMIT = 50;

const WITHDRAWAL_ADDRESS_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function toWithdrawalAddressDto(row: WalletWithdrawalAddressRow): WithdrawalAddress {
  return {
    id: row.id,
    label: row.label,
    currency: row.currency,
    network: row.network,
    address: row.address,
    destinationTag: row.destinationTag,
    createdAt: row.createdAt.toISOString(),
    usableFrom: new Date(row.createdAt.getTime() + WITHDRAWAL_ADDRESS_COOLDOWN_MS).toISOString(),
  };
}

const DEFAULT_WALLET_CURRENCY = 'USD';

const WALLET_MUTATION_RATE_LIMIT = { limit: 30, windowMs: 60 * 1000 };

type WithdrawalAsset = {
  network: string;
  minWithdrawal: string;
  withdrawalFee?: string;
  withdrawalEnabled: boolean;
};

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

export function assertAboveMinimumWithdrawal(
  assets: readonly WithdrawalAsset[],
  amount: string,
  currency: string,
  network: string | null,
): void {
  const asset = payableAsset(assets, network);
  if (asset && moneyCompare(amount, asset.minWithdrawal) < 0) {
    throw new BelowMinimumWithdrawalError(amount, asset.minWithdrawal, currency, asset.network);
  }
}

function payableAsset(assets: readonly WithdrawalAsset[], network: string | null) {
  return assets.find(
    (candidate) => candidate.withdrawalEnabled && candidate.network.toUpperCase() === network,
  );
}

export function withdrawalFeeFor(
  assets: readonly WithdrawalAsset[],
  amount: string,
  currency: string,
  network: string | null,
): string | null {
  const fee = payableAsset(assets, network)?.withdrawalFee;
  if (fee === undefined || moneyCompare(fee, '0') <= 0) {
    return null;
  }
  if (moneyCompare(amount, fee) <= 0) {
    throw new WithdrawalAmountNotAboveFeeError(amount, fee, currency);
  }
  return fee;
}

export function assertPayablePrecision(
  decimals: number | null,
  amounts: readonly (string | null)[],
  currency: string,
  network: string,
): void {
  if (decimals === null) {
    return;
  }
  for (const amount of amounts) {
    const fraction = amount?.split('.')[1]?.replace(/0+$/, '') ?? '';
    if (amount !== null && fraction.length > decimals) {
      throw new WithdrawalPrecisionError(amount, currency, network, decimals);
    }
  }
}

type DepositAsset = {
  network: string;
  minDeposit: string;
  depositEnabled: boolean;
};

export function requireBonusFundLocks(
  platformConfig: PlatformConfig | undefined,
  locks: BonusFundLockCommands | undefined,
): BonusFundLockCommands | undefined {
  if (!locks && resolvePromoConfig(platformConfig).bonus.withdrawalWhileActive === 'block') {
    throw new Error(
      "promo.bonus.withdrawalWhileActive is 'block' but nothing binds BONUS_FUND_LOCKS: load the bonus module beside the wallet or set the mode to 'forfeit'",
    );
  }
  return locks;
}

export function assertDepositAllowed(
  assets: readonly DepositAsset[],
  currency: string,
  network?: string,
): void {
  if (assets.length === 0) {
    if (network !== undefined) {
      throw new UnsupportedNetworkError(currency, network.toUpperCase());
    }
    return;
  }
  if (network === undefined) {
    if (!assets.some((asset) => asset.depositEnabled)) {
      throw new DepositDisabledError(currency, null);
    }
    return;
  }
  const wanted = network.toUpperCase();
  const asset = assets.find((candidate) => candidate.network.toUpperCase() === wanted);
  if (!asset) {
    throw new UnsupportedNetworkError(currency, wanted);
  }
  if (!asset.depositEnabled) {
    throw new DepositDisabledError(currency, asset.network);
  }
}

export function depositFloor(assets: readonly DepositAsset[], network?: string) {
  const wanted = network?.toUpperCase();
  const applicable = wanted
    ? assets.filter((asset) => asset.network.toUpperCase() === wanted)
    : assets;
  return applicable.reduce<DepositAsset | undefined>(
    (lowest, asset) =>
      !lowest || moneyCompare(asset.minDeposit, lowest.minDeposit) < 0 ? asset : lowest,
    undefined,
  );
}

export function assertAboveMinimumDeposit(
  assets: readonly DepositAsset[],
  amount: string,
  currency: string,
  network?: string,
): void {
  const floor = depositFloor(
    assets.filter((asset) => asset.depositEnabled),
    network,
  );
  if (floor && moneyCompare(amount, floor.minDeposit) < 0) {
    throw new BelowMinimumDepositError(amount, floor.minDeposit, currency, floor.network);
  }
}

export const railFor: (currency: string, cryptoCurrencies?: readonly string[]) => WalletRail =
  sharedRailFor;

async function openWallet(txn: DrizzleDb, userId: Wallet['userId'], currency: string) {
  const [created] = await txn
    .insert(wallet)
    .values({ userId, currency })
    .onConflictDoNothing({ target: wallet.userId })
    .returning();
  return (
    created ??
    findOneOrThrow(
      await txn.select().from(wallet).where(eq(wallet.userId, userId)),
      new WalletNotFoundError(userId),
    )
  );
}

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

export async function stampBalanceAfter(
  txn: DrizzleDb,
  transactionId: WalletTransaction['id'],
  balanceAfter: string,
): Promise<void> {
  await txn
    .update(walletTransaction)
    .set({ balanceAfter })
    .where(eq(walletTransaction.id, transactionId));
}

async function creditAndStampBalance(
  txn: DrizzleDb,
  transactionId: WalletTransaction['id'],
  walletId: Wallet['id'],
  currency: string,
  amount: string,
): Promise<void> {
  const [credited] = await creditWalletBalance(txn, walletId, currency, amount);
  if (credited) {
    await stampBalanceAfter(txn, transactionId, credited.amount);
  }
}

export async function collectWalletBalance(
  txn: DrizzleDb,
  walletId: Wallet['id'],
  currency: string,
  amount: string,
): Promise<{ balance: string; collected: string } | undefined> {
  const key = balanceKey(currency);
  const result = await txn.execute<{ balance: string; collected: string }>(sql`
    with held as (
      select amount from ${walletBalance}
      where ${walletBalance.walletId} = ${walletId} and ${walletBalance.currency} = ${key}
      for update
    )
    update ${walletBalance} wb
    set amount = wb.amount - least(held.amount, ${amount}::numeric), updated_at = now()
    from held
    where wb.wallet_id = ${walletId} and wb.currency = ${key} and held.amount > 0
    returning wb.amount::text as balance, least(held.amount, ${amount}::numeric)::text as collected
  `);
  return result.rows[0];
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

export async function readWalletBalanceForUpdate(
  txn: DrizzleDb,
  walletId: Wallet['id'],
  currency: string,
): Promise<string> {
  const [row] = await txn
    .select({ amount: walletBalance.amount })
    .from(walletBalance)
    .where(
      and(eq(walletBalance.walletId, walletId), eq(walletBalance.currency, balanceKey(currency))),
    )
    .for('update');
  return row?.amount ?? '0';
}

export async function readWalletBalances(
  txn: DrizzleDb,
  userId: User['id'],
  defaultCurrency = DEFAULT_WALLET_CURRENCY,
): Promise<{ activeCurrency: string; balances: { currency: string; balance: string }[] }> {
  const [record] = await txn.select().from(wallet).where(eq(wallet.userId, userId));

  if (!record) {
    return { activeCurrency: defaultCurrency, balances: [] };
  }

  const balances = await txn
    .select({ currency: walletBalance.currency, balance: walletBalance.amount })
    .from(walletBalance)
    .where(eq(walletBalance.walletId, record.id))
    .orderBy(walletBalance.currency);

  return { activeCurrency: record.currency, balances };
}

export async function resolveWalletBalance(
  txn: DrizzleDb,
  userId: User['id'],
  defaultCurrency = DEFAULT_WALLET_CURRENCY,
): Promise<{ balance: string; currency: string }> {
  const [record] = await txn.select().from(wallet).where(eq(wallet.userId, userId));
  if (!record) {
    return { balance: '0', currency: defaultCurrency };
  }
  return {
    balance: await readWalletBalance(txn, record.id, record.currency),
    currency: record.currency,
  };
}

const SNAPSHOT_READ = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;

const DEPOSIT_IDEMPOTENCY_NAMESPACE = 'deposit';
const WITHDRAW_IDEMPOTENCY_NAMESPACE = 'withdraw';
const MANUAL_ADJUSTMENT_IDEMPOTENCY_NAMESPACE = 'manual-adjustment';

export function providerRefCondition(
  providerName: string,
  providerRefId: WalletProviderRef['providerRefId'],
) {
  return and(
    eq(walletTransaction.providerName, providerName),
    eq(walletTransaction.providerRefId, providerRefId),
  );
}

type DepositEvent = Extract<PaymentWebhookEvent, { kind: 'deposit' }>;
type DepositStatusEvent = Extract<PaymentWebhookEvent, { kind: 'deposit_status' }>;
type DepositAddressTarget = Pick<DepositEvent, 'address' | 'network' | 'tag'> &
  Partial<Pick<DepositEvent, 'currency'>>;
type DepositOutcome = {
  event: Pick<DepositEvent, 'externalId' | 'amount' | 'currency'>;
  network: string | null;
  depositAddress: WalletDepositAddress;
  playerId: Player['id'] | null;
  detail: Record<string, string | null>;
};

export function isRecordableDeposit({
  externalId,
  amount,
}: Pick<DepositEvent, 'externalId' | 'amount'>) {
  return externalId.trim() !== '' && MoneyAmountSchema.safeParse(amount).success;
}

export function depositStatusIsNoOp(
  seen: ReadonlySet<WalletDepositStatusEventStatus>,
  status: WalletDepositStatusEventStatus,
) {
  return (
    seen.has('below_minimum') || seen.has(status) || (status === 'detected' && seen.has('failed'))
  );
}

export function soleNetworkForCurrency(
  rows: readonly Pick<WalletDepositAddress, 'currency' | 'network'>[],
  currency: string,
) {
  const sameCurrency = rows.filter((row) => row.currency.toUpperCase() === currency.toUpperCase());
  return sameCurrency.length === 1 ? (sameCurrency[0]?.network ?? undefined) : undefined;
}

function assertRecordableDeposit(event: Pick<DepositEvent, 'externalId' | 'amount'>) {
  if (!isRecordableDeposit(event)) {
    throw new MalformedDepositEventError(event.externalId);
  }
}

export function isAddressCurrencyMismatch(
  event: Pick<DepositEvent, 'network' | 'currency'>,
  depositAddress: Pick<WalletDepositAddress, 'currency'>,
) {
  return (
    event.network === undefined &&
    event.currency.toUpperCase() !== depositAddress.currency.toUpperCase()
  );
}

export type HandDeposit = {
  userId: User['id'];
  adminId: User['id'];
  amount: string;
  currency: string;
  network: string | null;
  providerName: string;
  providerRefId: string | null;
  address: string | null;
  tag: string | null;
  txHash: string | null;
};

export const depositSlotKey = (userId: User['id']) => `wallet-deposit:${userId}`;

const UNOPENED_ON_RAMP_HOLD = '15 minutes';
const UNCREDITED_ON_RAMP_HOLD = '1 day';

const heldReason = (deposit: Pick<WalletTransaction, 'status' | 'reviewReason'>) =>
  deposit.status === 'on_hold' ? (deposit.reviewReason ?? 'held for review') : null;

const MANUAL_ADJUSTMENT_TYPES: ReadonlySet<string> = new Set(['manual_credit', 'manual_debit']);

type TransactionHistoryRow = {
  id: string;
  type: WalletTransactionType;
  amount: string;
  currency: string;
  network: string | null;
  status: WalletTransactionStatus;
  direction: ManualAdjustmentDirection | null;
  created_at: string;
  rail: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_reason: string | null;
  reference_currency: string | null;
  reference_amount: string | null;
  reference_rate: string | null;
  reference_rate_as_of: string | null;
  provider_ref_id: string | null;
  tx_hash: string | null;
  fee: string | null;
  balance_after: string | null;
  provider_name: string | null;
  metadata: string | null;
};

function claimIdOf(raw: string | null): Uuid | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const claimId =
      typeof parsed === 'object' && parsed !== null && 'claimId' in parsed ? parsed.claimId : null;
    const checked = UuidSchema.safeParse(claimId);
    return checked.success ? checked.data : null;
  } catch {
    return null;
  }
}

const TX_SORT_COLUMNS = {
  createdAt: 'created_at',
  amount: 'amount',
  type: 'type',
  status: 'status',
  currency: 'currency',
  rail: 'rail',
  reviewedAt: 'reviewed_at',
} as const satisfies Record<WalletTransactionSortBy, keyof TransactionHistoryRow>;

export function namespacedIdempotencyKey(namespace: string, rawKey: string): string {
  if (namespace.includes(':')) {
    throw new RangeError(`idempotency namespace must not contain ':' (got ${namespace})`);
  }
  const hex = createHash('sha256').update(`${namespace}:${rawKey}`).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

const LARGE_WITHDRAWAL_THRESHOLD = '5000';

export const VELOCITY_IGNORED_STATUSES = [
  'failed',
  'cancelled',
] as const satisfies readonly WalletTransactionStatus[];

export const depositedAt = () =>
  sql<Date>`coalesce(${walletTransaction.reviewedAt}, ${walletTransaction.createdAt})`;

export const IN_FLIGHT_TRANSACTION_STATUSES = [
  'pending',
  'on_hold',
  'processing',
] as const satisfies readonly WalletTransactionStatus[];

const ACTIVITY_TRANSACTION_TYPES = ['deposit', 'withdrawal', 'bet', 'win', 'win_reversal'] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const hoursIn = (ms: number) => Math.round((Math.max(0, ms) / HOUR_MS) * 10) / 10;

const DAILY_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

const AUTO_APPROVED_REASON = 'auto-approved';

function assertWithdrawalIn(
  row: WalletTransaction,
  statuses: readonly WalletTransaction['status'][],
) {
  if (row.type !== 'withdrawal' || !statuses.includes(row.status)) {
    throw new WithdrawalNotPendingError();
  }
}

function playerWithdrawal(userId: User['id'], withdrawalId: WalletTransaction['id']) {
  return and(
    eq(walletTransaction.id, withdrawalId),
    eq(walletTransaction.type, 'withdrawal'),
    eq(wallet.userId, userId),
  );
}

type AutoApprovalDecision = {
  threshold: string;
  thresholdSource: 'per-player' | 'global';
  kycRequired: boolean;
  kycStatus: KycStatus | null;
  riskTagsEvaluated: TagKey[];
  effectiveExcludeTags: TagKey[];
  pivotAmount: string;
  pivotCurrency: string;
  dailyCapAmount: string | null;
  dailyCapCount: number | null;
  cumulativeAmountUsed: string | null;
  cumulativeCountUsed: number;
};

type AutoApprovalGates = Pick<
  AutoApprovalDecision,
  | 'threshold'
  | 'thresholdSource'
  | 'kycRequired'
  | 'kycStatus'
  | 'riskTagsEvaluated'
  | 'effectiveExcludeTags'
  | 'pivotAmount'
  | 'pivotCurrency'
>;

type ReferenceSnapshot = Pick<
  WalletTransaction,
  'referenceCurrency' | 'referenceAmount' | 'referenceRate' | 'referenceRateAsOf'
>;

export function payoutAmount(tx: Pick<WalletTransaction, 'amount' | 'fee'>): string {
  return tx.fee === null ? tx.amount : moneySubtract(tx.amount, tx.fee);
}

function toReferenceDto(row: ReferenceSnapshot): WalletReferenceConversion | null {
  if (
    row.referenceCurrency === null ||
    row.referenceAmount === null ||
    row.referenceRate === null ||
    row.referenceRateAsOf === null
  ) {
    return null;
  }
  return {
    currency: row.referenceCurrency,
    amount: row.referenceAmount,
    rate: row.referenceRate,
    rateAsOf: row.referenceRateAsOf.toISOString(),
  };
}

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
    velocityCount: row.velocityCount,
    velocityWindowHours: row.velocityWindowHours,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
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
  paymentProviders: PaymentProviderRegistry;
  identityReader: IdentityReader;
  directory?: AdminUserDirectory;
  platformConfig?: PlatformConfig;
  limiter?: RateLimiterAdapter<RateLimitKey>;
  riskTags: PlayerTags;
  audit: AuditWritePort;
  rgLimits?: RgLimitsPort;
  rates?: ExchangeRateReader;
  kycPolicy: KycWithdrawalPolicy;
  withdrawalSecurity: WithdrawalSecurity;
  mailDispatch?: MailDispatchPort;
  depositHold?: DepositHoldPolicy;
  depositAdmission?: DepositAdmissionPolicy;
  playEligibility?: PlayEligibilityPort;
  grantLedger?: BonusGrantLedgerReader;
  bonusFundLocks?: BonusFundLockCommands;
  bonusLifecycle?: BonusLifecycleCommands;
  depositBonus?: BonusDepositCommands;
  turnover?: TurnoverService;
};

export class WalletService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly payment: PaymentAdapter;
  private readonly paymentProviders: PaymentProviderRegistry;
  private readonly identityReader: IdentityReader;
  private readonly directory?: AdminUserDirectory;
  private readonly platformConfig?: PlatformConfig;
  private readonly limiter?: RateLimiterAdapter<RateLimitKey>;
  private readonly riskTags: PlayerTags;
  private readonly audit: AuditWritePort;
  private readonly rgLimits?: RgLimitsPort;
  private readonly rates?: ExchangeRateReader;
  private readonly kycPolicy: KycWithdrawalPolicy;
  private readonly withdrawalSecurity: WithdrawalSecurity;
  private readonly mailDispatch?: MailDispatchPort;
  private readonly depositHold?: DepositHoldPolicy;
  private readonly depositAdmission?: DepositAdmissionPolicy;
  private readonly playEligibility?: PlayEligibilityPort;

  private readonly grantLedger?: BonusGrantLedgerReader;
  private readonly bonusFundLocks?: BonusFundLockCommands;
  private readonly bonusLifecycle?: BonusLifecycleCommands;
  private readonly depositBonus?: BonusDepositCommands;
  private readonly turnover?: TurnoverService;

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
    audit,
    rgLimits,
    rates,
    kycPolicy,
    withdrawalSecurity,
    mailDispatch,
    depositHold,
    depositAdmission,
    playEligibility,
    grantLedger,
    bonusFundLocks,
    bonusLifecycle,
    depositBonus,
    turnover,
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
    this.audit = audit;
    this.rgLimits = rgLimits;
    this.rates = rates;
    this.kycPolicy = kycPolicy;
    this.withdrawalSecurity = withdrawalSecurity;
    this.mailDispatch = mailDispatch;
    this.depositHold = depositHold;
    this.depositAdmission = depositAdmission;
    this.playEligibility = playEligibility;
    this.grantLedger = grantLedger;
    this.bonusFundLocks = bonusFundLocks;
    this.bonusLifecycle = bonusLifecycle;
    this.depositBonus = depositBonus;
    this.turnover = turnover;
  }

  private async depositCompleted(
    txn: DrizzleTx,
    deposit: DomainEventPayload<'wallet.deposit.completed'>,
  ) {
    await this.depositBonus?.applyDeposit(txn, {
      userId: deposit.userId,
      amount: deposit.amount,
      currency: deposit.currency,
      transactionId: deposit.transactionId,
    });
    await this.turnover?.addCredit(txn, {
      userId: deposit.userId,
      kind: 'deposit',
      sourceRef: deposit.transactionId,
      currency: deposit.currency,
      amount: deposit.amount,
    });
    await this.events.emitInTransaction(txn, 'wallet.deposit.completed', deposit);
  }

  private assetsForCurrency(currency: string) {
    return this.drizzle.db
      .select({
        network: walletAsset.network,
        minWithdrawal: walletAsset.minWithdrawal,
        withdrawalFee: walletAsset.withdrawalFee,
        withdrawalEnabled: walletAsset.withdrawalEnabled,
      })
      .from(walletAsset)
      .where(eq(walletAsset.currency, currency.toUpperCase()));
  }

  private selectDepositAssets(currency: string, db: DrizzleDb | DrizzleTx) {
    return db
      .select({
        network: walletAsset.network,
        minDeposit: walletAsset.minDeposit,
        depositEnabled: walletAsset.depositEnabled,
      })
      .from(walletAsset)
      .where(eq(walletAsset.currency, currency.toUpperCase()));
  }

  private depositAssetsForCurrency(currency: string, db: DrizzleDb = this.drizzle.db) {
    return this.selectDepositAssets(currency, db).for('share');
  }

  private async assertDepositable(
    currency: string,
    amount?: string,
    network?: string,
    db: DrizzleDb = this.drizzle.db,
  ) {
    const assets = await this.depositAssetsForCurrency(currency, db);
    assertDepositAllowed(assets, currency, network);
    if (amount !== undefined) {
      assertAboveMinimumDeposit(assets, amount, currency, network);
    }
  }

  async assertWithinRgDepositLimit(
    tx: DrizzleDb | DrizzleTx,
    userId: User['id'],
    amount: string,
    currency: string,
  ) {
    if (!this.rgLimits) {
      return;
    }
    const pending = await this.uncreditedOnRampTotal(tx, userId, currency);
    const decision = await this.rgLimits.checkDeposit(
      tx,
      userId,
      moneyAdd(amount, pending),
      currency,
    );
    if (decision.allowed) {
      return;
    }
    const countsPending =
      isPositiveMoney(pending) &&
      decision.currency === currency &&
      moneyCompare(decision.used, decision.limit) !== 0;
    throw new RgLimitExceededError(
      'deposit_limit_exceeded',
      countsPending ? { ...decision, used: moneyAdd(decision.used, pending) } : decision,
    );
  }

  private async uncreditedOnRampTotal(
    tx: DrizzleDb | DrizzleTx,
    userId: User['id'],
    currency: string,
  ): Promise<string> {
    const order = walletOnRampOrder;
    const openByFiat = await tx
      .select({
        fiatCurrency: order.fiatCurrency,
        total: sql<string>`sum(${order.fiatAmount})::text`,
      })
      .from(order)
      .where(
        and(
          eq(order.userId, userId),
          or(
            eq(order.status, 'processing'),
            and(
              eq(order.status, 'pending'),
              or(
                gt(order.expiresAt, sql`now()`),
                and(
                  isNull(order.expiresAt),
                  gt(order.createdAt, sql`now() - ${UNOPENED_ON_RAMP_HOLD}::interval`),
                ),
              ),
            ),
            and(
              eq(order.status, 'completed'),
              gt(order.updatedAt, sql`now() - ${UNCREDITED_ON_RAMP_HOLD}::interval`),
              notExists(
                tx
                  .select({ id: walletTransaction.id })
                  .from(walletTransaction)
                  .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
                  .where(
                    and(
                      eq(walletTransaction.txHash, order.txHash),
                      eq(wallet.userId, order.userId),
                      eq(walletTransaction.type, 'deposit'),
                      eq(walletTransaction.status, 'completed'),
                    ),
                  ),
              ),
            ),
          ),
        ),
      )
      .groupBy(order.fiatCurrency);
    const totals = await mapConcurrent(openByFiat, 1, async (open) => {
      if (open.fiatCurrency === currency) {
        return open.total;
      }
      const converted =
        (await this.rates?.convert(open.total, open.fiatCurrency, currency, tx)) ?? null;
      if (converted === null) {
        throw new WalletReferenceRateUnavailableError(open.fiatCurrency, currency);
      }
      return converted;
    });
    return totals.reduce<string>((sum, total) => moneyAdd(sum, total), '0');
  }

  private resolveRail(currency: string): WalletRail {
    return railFor(currency, this.platformConfig?.wallet?.cryptoCurrencies);
  }

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

  private async paymentAdapterFor(currency: string, network: string | null) {
    const providerName = await this.providerNameFor(currency, network);
    if (providerName === DEFAULT_PAYMENT_PROVIDER) {
      return { providerName, adapter: this.payment };
    }
    const adapter = this.paymentProviders.get(providerName)?.adapter;
    if (!adapter) {
      throw new WalletAssetUnknownProviderError();
    }
    return { providerName, adapter };
  }

  private async referenceSnapshot(
    tx: DrizzleDb | DrizzleTx,
    userId: User['id'],
    amount: string,
    currency: string,
  ) {
    const referenceCurrency =
      (await this.rgLimits?.referenceCurrency(tx, userId)) ??
      resolveWalletReferenceCurrency(this.platformConfig?.wallet);
    const quote =
      currency.toUpperCase() === referenceCurrency
        ? { rate: '1', asOf: new Date().toISOString() }
        : await this.rates?.getRate(currency, referenceCurrency, tx);
    if (!quote) {
      throw new WalletReferenceRateUnavailableError(currency, referenceCurrency);
    }
    return {
      referenceCurrency,
      referenceAmount: moneyScaleBy(amount, quote.rate),
      referenceRate: quote.rate,
      referenceRateAsOf: new Date(quote.asOf),
    };
  }

  private rateLimit(userId: User['id']) {
    return this.limiter
      ? assertRateLimit(this.limiter, `wallet-mutation:${userId}`, WALLET_MUTATION_RATE_LIMIT)
      : Promise.resolve();
  }

  private async assertKycForWithdrawal(userId: User['id'], amount: string, currency: string) {
    if (await this.kycBlocksWithdrawal(userId, amount, currency)) {
      throw new KycRequiredError();
    }
  }

  private async kycBlocksWithdrawal(
    userId: User['id'],
    amount: string,
    currency: string,
  ): Promise<boolean> {
    if (!this.platformConfig?.kyc?.gateWithdrawals) {
      return false;
    }
    const pivotCurrency = resolveExchangeRatePivot(this.platformConfig.exchangeRate);
    const pivotAmount = await this.toPivotAmount(amount, currency, pivotCurrency);
    if (!(await this.withdrawalNeedsKyc(userId, pivotAmount, pivotCurrency))) {
      return false;
    }
    return !isKycPassed(await this.autoApprovalKycStatus(userId));
  }

  private async approvalBlock(
    userId: User['id'],
    { amount, currency }: Pick<WalletTransaction, 'amount' | 'currency'>,
  ): Promise<{ reason: WithdrawalRequeueReason; error: Error } | null> {
    if (await this.isWithdrawalLocked(userId)) {
      return { reason: 'withdrawal_lock', error: new WithdrawalLockedError() };
    }
    const pinLockedUntil = await this.withdrawalSecurity.pinLockedUntil(userId);
    if (pinLockedUntil) {
      return {
        reason: 'withdrawal_pin_locked',
        error: new WithdrawalPinLockedError(pinLockedUntil),
      };
    }
    if (await this.kycBlocksWithdrawal(userId, amount, currency)) {
      return { reason: 'kyc_required', error: new KycRequiredError() };
    }
    return null;
  }

  private withdrawalNeedsKyc(
    userId: User['id'],
    pivotAmount: string | null,
    pivotCurrency: string,
  ): Promise<boolean> {
    return this.kycPolicy.requiresKycForWithdrawal({ userId, pivotAmount, pivotCurrency });
  }

  private async assertWithdrawalsNotLocked(userId: User['id']) {
    if (await this.isWithdrawalLocked(userId)) {
      throw new WithdrawalLockedError();
    }
  }

  private async isWithdrawalHeld(db: DrizzleDb, userId: User['id']): Promise<boolean> {
    return (await this.withdrawalHeldUserIds([userId], db)).has(userId);
  }

  private async withdrawalHeldUserIds(
    userIds: readonly User['id'][],
    db: DrizzleDb = this.drizzle.db,
  ): Promise<Set<string>> {
    if (userIds.length === 0) {
      return new Set();
    }
    const rows = await db
      .selectDistinct({ userId: walletWithdrawalHold.userId })
      .from(walletWithdrawalHold)
      .where(inArray(walletWithdrawalHold.userId, [...userIds]));
    return new Set(rows.map((r) => r.userId));
  }

  private async findCommittedWithdrawal({
    userId,
    idempotencyKey,
    amount,
    currency,
  }: {
    userId: User['id'];
    idempotencyKey: string | undefined;
    amount: string;
    currency: string;
  }): Promise<TransactionResult | null> {
    if (!idempotencyKey) {
      return null;
    }
    const [owned] = await this.drizzle.db
      .select({ id: wallet.id })
      .from(wallet)
      .where(eq(wallet.userId, userId));
    if (!owned) {
      return null;
    }
    const existing = await this.findByIdempotencyKey(
      this.drizzle.db,
      owned.id,
      namespacedIdempotencyKey(WITHDRAW_IDEMPOTENCY_NAMESPACE, idempotencyKey),
    );
    if (!existing) {
      return null;
    }
    this.assertReplayMatches(existing, amount, currency);
    return { transactionId: existing.id, status: existing.status };
  }

  private async assertWithdrawalPin(
    userId: User['id'],
    pin: string | undefined,
    meta: Partial<ClientMeta>,
  ) {
    const verdict = await this.withdrawalSecurity.verifyPin({ userId, pin, meta });
    switch (verdict.status) {
      case 'missing':
        throw new WithdrawalPinRequiredError();
      case 'incorrect':
        throw new WithdrawalPinIncorrectError(verdict.attemptsLeft);
      case 'locked':
        throw new WithdrawalPinLockedError(verdict.lockedUntil);
      default:
        return;
    }
  }

  private async findSavedWithdrawalAddress(
    userId: User['id'],
    currency: string,
    network: string | null,
    address: string,
    destinationTag: string | null | undefined,
  ) {
    const [row] = await this.drizzle.db
      .select({ createdAt: walletWithdrawalAddress.createdAt })
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
    return row ?? null;
  }

  private async assertDestinationAddressMatured(
    userId: User['id'],
    currency: string,
    network: string | null,
    address: string,
    destinationTag: string | null | undefined,
  ) {
    const saved = await this.findSavedWithdrawalAddress(
      userId,
      currency,
      network,
      address,
      destinationTag,
    );
    if (!saved) {
      throw new DestinationAddressCoolingDownError(null);
    }
    const usableFrom = new Date(saved.createdAt.getTime() + WITHDRAWAL_ADDRESS_COOLDOWN_MS);
    if (usableFrom.getTime() > Date.now()) {
      throw new DestinationAddressCoolingDownError(usableFrom);
    }
  }

  private async isWithdrawalLocked(userId: User['id']): Promise<boolean> {
    return (await this.withdrawalLockedUserIds([userId])).has(userId);
  }

  private async withdrawalLockedUserIds(userIds: readonly User['id'][]): Promise<Set<string>> {
    if (userIds.length === 0) {
      return new Set();
    }
    const byUser = await this.riskTags.getActiveTagKeys(userIds);
    return new Set(
      [...byUser].filter(([, keys]) => keys.includes(WITHDRAWAL_LOCK_TAG)).map(([id]) => id),
    );
  }

  private async withdrawalOwner(withdrawalId: WalletTransaction['id']) {
    const [row] = await this.drizzle.db
      .select({
        userId: wallet.userId,
        amount: walletTransaction.amount,
        currency: walletTransaction.currency,
      })
      .from(walletTransaction)
      .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
      .where(eq(walletTransaction.id, withdrawalId));
    if (!row) {
      throw new WithdrawalNotFoundError(withdrawalId);
    }
    return row;
  }

  getBalance(userId: User['id']) {
    return this.drizzle.db.transaction(async (txn) => {
      const reading = await resolveWalletBalance(
        txn,
        userId,
        this.platformConfig?.wallet?.defaultCurrency,
      );
      const [withLocks] = await this.withLockedFunds(txn, userId, [reading]);
      return withLocks ?? reading;
    }, SNAPSHOT_READ);
  }

  getBalances(userId: User['id']) {
    return this.drizzle.db.transaction(async (txn) => {
      const reading = await readWalletBalances(
        txn,
        userId,
        this.platformConfig?.wallet?.defaultCurrency,
      );
      return { ...reading, balances: await this.withLockedFunds(txn, userId, reading.balances) };
    }, SNAPSHOT_READ);
  }

  private async withLockedFunds<T extends { currency: string; balance: string }>(
    txn: DrizzleDb,
    userId: User['id'],
    balances: T[],
  ): Promise<(T & Partial<LockedFunds> & { bonusLocked?: string })[]> {
    const turnover = this.turnover?.enabled ? this.turnover : undefined;
    if ((!this.bonusFundLocks && !turnover) || balances.length === 0) {
      return balances;
    }
    const locks = this.bonusFundLocks
      ? await this.bonusFundLocks.readLockedFunds(txn, {
          userId,
          balances: balances.map(({ currency, balance }) => ({
            currency: balanceKey(currency),
            realBalance: balance,
          })),
        })
      : [];
    if (!turnover) {
      return balances.map((balance, i) => ({ ...balance, ...locks[i] }));
    }
    const turnoverLocked = (await turnover.summary(userId, txn)).locked;
    return balances.map((row, i) =>
      withTurnoverLock(row, locks[i] ?? { locked: '0', free: row.balance }, turnoverLocked),
    );
  }

  async getActivity({ userId, windowDays }: { userId: User['id']; windowDays: number }) {
    const since = new Date(Date.now() - windowDays * DAY_MS);
    const [{ activeCurrency, balances }, totals, openWithdrawals] = await Promise.all([
      this.getBalances(userId),
      this.completedTotalsSince(userId, since),
      this.openWithdrawals(userId),
    ]);
    return { windowDays, activeCurrency, balances, totals, openWithdrawals };
  }

  private completedTotalsSince(userId: User['id'], since: Date) {
    const sumOf = (type: (typeof ACTIVITY_TRANSACTION_TYPES)[number]) =>
      sql<string>`coalesce(sum(${walletTransaction.amount}) filter (where ${walletTransaction.type} = ${type}), 0)`;
    const countOf = (type: (typeof ACTIVITY_TRANSACTION_TYPES)[number]) =>
      sql<number>`count(*) filter (where ${walletTransaction.type} = ${type})`.mapWith(Number);
    return this.drizzle.db
      .select({
        currency: walletTransaction.currency,
        deposits: sumOf('deposit'),
        depositCount: countOf('deposit'),
        withdrawals: sumOf('withdrawal'),
        withdrawalCount: countOf('withdrawal'),
        bets: sumOf('bet'),
        wins: sql<string>`greatest(${sumOf('win')} - ${sumOf('win_reversal')}, 0)`,
      })
      .from(walletTransaction)
      .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
      .where(
        and(
          eq(wallet.userId, userId),
          eq(walletTransaction.status, 'completed'),
          inArray(walletTransaction.type, [...ACTIVITY_TRANSACTION_TYPES]),
          gte(walletTransaction.createdAt, since),
        ),
      )
      .groupBy(walletTransaction.currency)
      .orderBy(walletTransaction.currency);
  }

  private async openWithdrawals(userId: User['id']) {
    const rows = await this.drizzle.db
      .select({
        withdrawalId: walletTransaction.id,
        amount: walletTransaction.amount,
        currency: walletTransaction.currency,
        status: walletTransaction.status,
        createdAt: walletTransaction.createdAt,
      })
      .from(walletTransaction)
      .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
      .where(
        and(
          eq(wallet.userId, userId),
          eq(walletTransaction.type, 'withdrawal'),
          inArray(walletTransaction.status, [...QUEUED_WITHDRAWAL_STATUSES]),
        ),
      )
      .orderBy(desc(walletTransaction.createdAt), desc(walletTransaction.id))
      .limit(OPEN_WITHDRAWALS_LIMIT);
    return rows.map(({ createdAt, ...row }) => ({ ...row, requestedAt: createdAt.toISOString() }));
  }

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
    await this.assertDepositable(currency, amount);

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
    await this.assertDepositAdmitted(userId);

    const reservation = await this.drizzle.db.transaction(async (txn) => {
      let walletRecord = preResolvedWallet;
      if (!walletRecord) {
        [walletRecord] = await txn.select().from(wallet).where(eq(wallet.userId, userId));
      }
      if (!walletRecord) {
        walletRecord = await openWallet(txn, userId, currency);
      }
      const holder = walletRecord;
      return withAdvisoryXactLock(txn, depositSlotKey(userId), async () => {
        const namespacedKey = idempotencyKey
          ? namespacedIdempotencyKey(DEPOSIT_IDEMPOTENCY_NAMESPACE, idempotencyKey)
          : undefined;
        const existing = namespacedKey
          ? await this.findByIdempotencyKey(txn, holder.id, namespacedKey)
          : undefined;
        if (existing) {
          this.assertReplayMatches(existing, amount, currency);
          return { walletRecord: holder, row: existing, replay: true };
        }

        await this.assertDepositPlayable(userId, txn);
        await this.assertWithinRgDepositLimit(txn, userId, amount, currency);

        const { row } = await this.insertIdempotentTransaction(txn, {
          namespace: DEPOSIT_IDEMPOTENCY_NAMESPACE,
          userId,
          walletId: holder.id,
          rawIdempotencyKey: idempotencyKey,
          amount,
          currency,
          values: {
            walletId: holder.id,
            type: 'deposit',
            amount,
            currency,
            status: 'pending',
            direction: 'credit',
            rail: this.resolveRail(currency),
            providerName: provider,
          },
        });
        return { walletRecord: holder, row, replay: false };
      });
    });

    if (reservation.replay) {
      return { transactionId: reservation.row.id, status: reservation.row.status };
    }

    let psp: Awaited<ReturnType<PaymentAdapter['processDeposit']>>;
    try {
      psp = await this.payment.processDeposit(amount, currency, { userId, provider });
    } catch (err) {
      await this.releaseDepositReservation(reservation.row.id);
      throw err;
    }

    const playerId = await this.identityReader.getPlayerIdByUserIdSafe(userId);
    const { transactionId } = await this.drizzle.db.transaction(async (txn) => {
      const [settled] = await txn
        .update(walletTransaction)
        .set({ status: 'completed', providerRefId: psp.externalId })
        .where(
          and(
            eq(walletTransaction.id, reservation.row.id),
            eq(walletTransaction.status, 'pending'),
          ),
        )
        .returning();
      if (!settled) {
        return { transactionId: reservation.row.id };
      }
      await creditAndStampBalance(txn, settled.id, reservation.walletRecord.id, currency, amount);
      await this.depositCompleted(txn, {
        userId,
        playerId,
        amount,
        currency,
        transactionId: settled.id,
      });
      return { transactionId: settled.id };
    });

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

    return this.drizzle.db.transaction(async (txn) => {
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
        return { transactionId: existing.id, status: existing.status };
      }

      const { row, replayed } = await this.insertIdempotentTransaction(txn, {
        namespace: MANUAL_ADJUSTMENT_IDEMPOTENCY_NAMESPACE,
        userId,
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
        return { transactionId: row.id, status: row.status };
      }

      const [balance] =
        direction === 'credit'
          ? await creditWalletBalance(txn, walletRecord.id, currency, amount)
          : await debitWalletBalance(txn, walletRecord.id, currency, amount);
      if (!balance) {
        throw new InsufficientBalanceError(
          await readWalletBalance(txn, walletRecord.id, currency),
          amount,
        );
      }
      await stampBalanceAfter(txn, row.id, balance.amount);
      const balanceBefore =
        direction === 'credit'
          ? moneySubtract(balance.amount, amount)
          : moneyAdd(balance.amount, amount);
      await this.audit.recordInTransaction(txn, {
        actorId: adminId,
        actorType: 'admin',
        action: 'wallet.manual_adjustment.created',
        resourceType: 'player',
        resourceId: playerId,
        before: { balance: balanceBefore, currency },
        after: {
          balance: balance.amount,
          currency,
          transactionId: row.id,
          direction,
          amount,
          reason,
          reference: toReferenceDto(row),
        },
        ip,
        userAgent,
      });
      await this.events.emitInTransaction(txn, 'wallet.manual_adjustment.created', {
        userId,
        playerId,
        adminId,
        amount,
        currency,
        transactionId: row.id,
        direction,
        reason,
        ip,
        userAgent,
      });
      return { transactionId: row.id, status: row.status };
    });
  }

  private async releaseDepositReservation(transactionId: WalletTransaction['id']): Promise<void> {
    try {
      await this.drizzle.db
        .update(walletTransaction)
        .set({ status: 'failed' })
        .where(
          and(eq(walletTransaction.id, transactionId), eq(walletTransaction.status, 'pending')),
        );
    } catch (err) {
      logger.error({ err, transactionId }, 'deposit reservation release failed');
    }
  }

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

  private async insertIdempotentTransaction(
    txn: DrizzleTx,
    {
      namespace,
      userId,
      walletId,
      rawIdempotencyKey,
      amount,
      currency,
      values,
    }: {
      namespace: string;
      userId: User['id'];
      walletId: Wallet['id'];
      rawIdempotencyKey: string | undefined;
      amount: string;
      currency: string;
      values: Omit<
        typeof walletTransaction.$inferInsert,
        'idempotencyKey' | 'direction' | keyof ReferenceSnapshot
      > & {
        direction: ManualAdjustmentDirection;
      };
    },
  ): Promise<{ row: WalletTransaction; replayed: boolean }> {
    const idempotencyKey = rawIdempotencyKey
      ? namespacedIdempotencyKey(namespace, rawIdempotencyKey)
      : undefined;

    const reference = await this.referenceSnapshot(txn, userId, amount, currency);
    const insertQuery = txn
      .insert(walletTransaction)
      .values({ ...values, ...reference, idempotencyKey: idempotencyKey ?? null });
    const [row] = idempotencyKey
      ? await insertQuery.onConflictDoNothing().returning()
      : await insertQuery.returning();

    if (row) {
      return { row, replayed: false };
    }

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

  async withdraw({
    userId,
    amount,
    currency,
    network,
    idempotencyKey,
    destinationAddress,
    destinationTag,
    withdrawalPin,
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
    withdrawalPin?: string;
  } & ClientMeta): Promise<TransactionResult> {
    await this.rateLimit(userId);
    const committed = await this.findCommittedWithdrawal({
      userId,
      idempotencyKey,
      amount,
      currency,
    });
    if (committed) {
      return committed;
    }
    await this.assertWithdrawalPin(userId, withdrawalPin, { ip, userAgent });
    await this.assertWithdrawalsNotLocked(userId);
    await this.assertKycForWithdrawal(userId, amount, currency);
    if (this.resolveRail(currency) === 'crypto' && !destinationAddress) {
      throw new DestinationAddressRequiredError();
    }
    const assets = await this.assetsForCurrency(currency);
    const settlementNetwork = resolveWithdrawalNetwork(assets, currency, network);
    assertAboveMinimumWithdrawal(assets, amount, currency, settlementNetwork);
    const fee = withdrawalFeeFor(assets, amount, currency, settlementNetwork);
    if (settlementNetwork !== null) {
      assertPayablePrecision(
        this.payment.withdrawalDecimals?.(currency, settlementNetwork) ?? null,
        [amount, fee],
        currency,
        settlementNetwork,
      );
    }
    const destinationWalletId = await this.requireWhitelistedWalletId(
      userId,
      currency,
      settlementNetwork,
      destinationAddress,
      destinationTag,
    );
    if (destinationAddress) {
      await this.assertDestinationAddressMatured(
        userId,
        currency,
        settlementNetwork,
        destinationAddress,
        destinationTag,
      );
    }
    const playerId = await this.identityReader.getPlayerIdByUserIdSafe(userId);
    await this.turnover?.pricePendingNow(userId);

    return this.drizzle.db.transaction(async (txn) => {
      const current = findOneOrThrow(
        await txn.select().from(wallet).where(eq(wallet.userId, userId)).for('update'),
        new WalletNotFoundError(userId),
      );
      if (idempotencyKey) {
        const existing = await this.findByIdempotencyKey(
          txn,
          current.id,
          namespacedIdempotencyKey(WITHDRAW_IDEMPOTENCY_NAMESPACE, idempotencyKey),
        );
        if (existing) {
          this.assertReplayMatches(existing, amount, currency);
          return { transactionId: existing.id, status: existing.status };
        }
      }
      if (await this.isWithdrawalHeld(txn, userId)) {
        throw new WithdrawalHeldError();
      }

      const { row, replayed } = await this.insertIdempotentTransaction(txn, {
        namespace: WITHDRAW_IDEMPOTENCY_NAMESPACE,
        userId,
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
          fee,
        },
      });

      if (replayed) {
        return { transactionId: row.id, status: row.status };
      }

      const [debited] = await debitWalletBalance(txn, current.id, currency, amount);
      if (!debited) {
        throw new InsufficientBalanceError(
          await readWalletBalance(txn, current.id, currency),
          amount,
        );
      }
      await stampBalanceAfter(txn, row.id, debited.amount);
      const forfeitContext = {
        actor: { id: userId, isAdmin: false },
        note: `withdrawal ${row.id}`,
        meta: { ip: ip ?? null, userAgent: userAgent ?? null },
      };
      await (this.bonusFundLocks
        ? this.bonusFundLocks.onOutflow(txn, {
            userId,
            currency: balanceKey(currency),
            amount,
            balanceAfter: debited.amount,
            outflow: 'withdrawal',
            ...forfeitContext,
          })
        : this.bonusLifecycle?.forfeitHeld(txn, {
            userId,
            reason: 'withdrawal_while_active',
            ...forfeitContext,
          }));
      await this.turnover?.assertOutflow(txn, { userId, outflow: 'withdrawal' });

      await this.events.emitInTransaction(txn, 'wallet.withdrawal.requested', {
        userId,
        playerId,
        amount,
        currency,
        transactionId: row.id,
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      });

      return { transactionId: row.id, status: row.status };
    });
  }

  async autoApproveScreenedWithdrawal({
    userId,
    transactionId,
    reviewRequired,
  }: {
    userId: User['id'];
    transactionId: WalletTransaction['id'];
    reviewRequired?: boolean;
  }): Promise<TransactionResult | undefined> {
    const [row] = await this.drizzle.db
      .select({
        amount: walletTransaction.amount,
        currency: walletTransaction.currency,
        walletId: walletTransaction.walletId,
        rail: walletTransaction.rail,
      })
      .from(walletTransaction)
      .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
      .where(
        and(
          eq(walletTransaction.id, transactionId),
          eq(walletTransaction.type, 'withdrawal'),
          eq(walletTransaction.status, 'pending'),
          eq(wallet.userId, userId),
        ),
      );
    if (!row?.rail) {
      return undefined;
    }
    return this.maybeAutoApprove({ userId, transactionId, reviewRequired, ...row, rail: row.rail });
  }

  private async withdrawalSearchCondition(search: string): Promise<SQL> {
    const sameAddressIgnoringCase = sql`lower(${walletTransaction.destinationAddress}) = ${search.toLowerCase()}`;
    const matches = [
      EVM_ADDRESS_PATTERN.test(search)
        ? sameAddressIgnoringCase
        : sql`(${sameAddressIgnoringCase} and ${walletTransaction.destinationAddress} = ${search})`,
    ];
    if (UuidSchema.safeParse(search).success) {
      matches.push(eq(wallet.userId, search));
    }
    const userIds = this.directory ? await this.directory.findPlayerIds(search) : [];
    if (userIds.length > 0) {
      matches.push(inArray(wallet.userId, userIds));
    }
    return sql`(${sql.join(matches, sql` or `)})`;
  }

  private async withdrawalConditions(
    filters: WithdrawalQueueSummaryFilter & Pick<WithdrawalQueueFilter, 'status'>,
    statuses?: readonly WalletTransaction['status'][],
  ) {
    const conditions = [eq(walletTransaction.type, 'withdrawal')];
    if (filters.search) {
      conditions.push(await this.withdrawalSearchCondition(filters.search));
    }
    if (filters.status) {
      conditions.push(eq(walletTransaction.status, filters.status));
    }
    if (statuses) {
      conditions.push(inArray(walletTransaction.status, [...statuses]));
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
    return conditions;
  }

  private async matchingWithdrawals(
    filters: WithdrawalQueueSummaryFilter &
      Pick<WithdrawalQueueFilter, 'status' | 'sortBy' | 'sortOrder'>,
    {
      statuses,
      withPlayers,
    }: { statuses?: readonly WalletTransaction['status'][]; withPlayers: boolean },
  ) {
    const db = this.drizzle.db;
    const conditions = await this.withdrawalConditions(filters, statuses);

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
    const needsPlayers = withPlayers || filters.kycStatus !== undefined;
    const summaries =
      this.directory && needsPlayers ? await this.directory.lookupPlayers(userIds) : [];
    const byUserId = new Map(summaries.map((s) => [s.userId, s]));

    const kycStatusFilter = filters.kycStatus ? normalizeKycStatus(filters.kycStatus) : undefined;
    const matching = kycStatusFilter
      ? rows.filter((r) => {
          const kycStatus = byUserId.get(r.userId)?.kycStatus;
          return kycStatus !== undefined && kycStatus !== null
            ? normalizeKycStatus(kycStatus) === kycStatusFilter
            : false;
        })
      : rows;

    return { matching, byUserId };
  }

  private static readonly EMPTY_WITHDRAWAL_SUMMARY: WithdrawalQueueSummary = {
    pendingCount: 0,
    onHoldCount: 0,
    queuedTotals: [],
    avgPendingWaitSeconds: null,
  };

  async summarizeWithdrawals(
    filters: WithdrawalQueueSummaryFilter,
  ): Promise<WithdrawalQueueSummary> {
    const db = this.drizzle.db;
    let kycUserIds: string[] | undefined;
    if (filters.kycStatus) {
      if (!this.directory) {
        return WalletService.EMPTY_WITHDRAWAL_SUMMARY;
      }
      kycUserIds = await this.directory.findUserIdsByKycStatus(filters.kycStatus);
      if (kycUserIds.length === 0) {
        return WalletService.EMPTY_WITHDRAWAL_SUMMARY;
      }
    }

    const conditions = await this.withdrawalConditions(filters, QUEUED_WITHDRAWAL_STATUSES);
    if (kycUserIds) {
      conditions.push(inArray(wallet.userId, kycUserIds));
    }

    const [[overall], totalsRows] = await Promise.all([
      db
        .select({
          pendingCount: sql<string>`count(*) filter (where ${walletTransaction.status} = 'pending')`,
          onHoldCount: sql<string>`count(*) filter (where ${walletTransaction.status} = 'on_hold')`,
          avgPendingWaitSeconds: sql<
            string | null
          >`avg(extract(epoch from now() - ${walletTransaction.createdAt})) filter (where ${walletTransaction.status} = 'pending')`,
        })
        .from(walletTransaction)
        .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
        .where(and(...conditions)),
      db
        .select({
          currency: walletTransaction.currency,
          total: sql<string>`coalesce(sum(${walletTransaction.amount}), 0)`,
        })
        .from(walletTransaction)
        .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
        .where(and(...conditions))
        .groupBy(walletTransaction.currency),
    ]);

    return {
      pendingCount: Number(overall?.pendingCount ?? 0),
      onHoldCount: Number(overall?.onHoldCount ?? 0),
      queuedTotals: totalsRows
        .map((r) => ({ currency: r.currency, amount: r.total }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
      avgPendingWaitSeconds:
        overall?.avgPendingWaitSeconds === null || overall?.avgPendingWaitSeconds === undefined
          ? null
          : Number(overall.avgPendingWaitSeconds),
    };
  }

  async listWithdrawals(filters: WithdrawalQueueFilter) {
    const { page, limit } = filters;
    const { matching, byUserId } = await this.matchingWithdrawals(filters, { withPlayers: true });

    const start = pageToOffset(page, limit);
    const pageRows = matching.slice(start, start + limit);

    const pageUserIds = [...new Set(pageRows.map((r) => r.userId))];
    const [riskTags, lockedUserIds, heldUserIds] = await Promise.all([
      this.withdrawalRiskTags(pageRows.map((r) => r.tx)),
      this.withdrawalLockedUserIds(pageUserIds),
      this.withdrawalHeldUserIds(pageUserIds),
    ]);

    const items: WithdrawalQueueItem[] = pageRows.map((r) => {
      const summary = byUserId.get(r.userId);
      return {
        transactionId: r.tx.id,
        userId: r.userId,
        playerId: summary?.playerId ?? null,
        username: summary?.username ?? '',
        amount: r.tx.amount,
        fee: r.tx.fee,
        currency: r.tx.currency,
        network: r.tx.network,
        rail: r.tx.rail ?? null,
        status: r.tx.status,
        kycStatus: summary?.kycStatus ?? null,
        riskTags: riskTags.get(r.tx.id) ?? [],
        withdrawalLocked: lockedUserIds.has(r.userId),
        withdrawalHeld: heldUserIds.has(r.userId),
        requestedAt: r.tx.createdAt.toISOString(),
        destinationAddress: r.tx.destinationAddress,
        destinationTag: r.tx.destinationTag,
        txHash: r.tx.txHash,
      };
    });

    return { items, total: matching.length, page, limit };
  }

  async withdrawalQueueOverview(
    { status, limit }: WithdrawalsQueueInput,
    now = new Date(),
  ): Promise<WithdrawalsQueue> {
    const [summary, oldest] = await Promise.all([
      this.summarizeWithdrawals({}),
      this.oldestQueuedWithdrawals(status ? [status] : QUEUED_WITHDRAWAL_STATUSES, limit),
    ]);
    return {
      pendingCount: summary.pendingCount,
      onHoldCount: summary.onHoldCount,
      queuedTotals: summary.queuedTotals.slice(0, WITHDRAWAL_QUEUE_MAX_CURRENCIES),
      avgPendingWaitHours:
        summary.avgPendingWaitSeconds === null
          ? null
          : hoursIn(summary.avgPendingWaitSeconds * 1000),
      oldest: oldest.map(({ requestedAt, ...item }) => ({
        ...item,
        requestedAt: requestedAt.toISOString(),
        waitHours: hoursIn(now.getTime() - requestedAt.getTime()),
      })),
    };
  }

  private async oldestQueuedWithdrawals(
    statuses: readonly QueuedWithdrawalStatus[],
    limit: number,
  ) {
    const rows = await this.drizzle.db
      .select({
        id: walletTransaction.id,
        walletId: walletTransaction.walletId,
        amount: walletTransaction.amount,
        currency: walletTransaction.currency,
        status: walletTransaction.status,
        createdAt: walletTransaction.createdAt,
        userId: wallet.userId,
      })
      .from(walletTransaction)
      .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
      .where(
        and(
          eq(walletTransaction.type, 'withdrawal'),
          inArray(walletTransaction.status, [...statuses]),
        ),
      )
      .orderBy(asc(walletTransaction.createdAt), asc(walletTransaction.id))
      .limit(limit);
    const userIds = [...new Set(rows.map((row) => row.userId))];
    const [players, riskTags] = await Promise.all([
      this.directory && userIds.length > 0 ? this.directory.lookupPlayers(userIds) : [],
      this.withdrawalRiskTags(rows),
    ]);
    const playerByUserId = new Map(players.map((player) => [player.userId, player]));
    return rows.map((row) => {
      const player = playerByUserId.get(row.userId);
      return {
        withdrawalId: row.id,
        playerId: player?.playerId ?? null,
        amount: row.amount,
        currency: row.currency,
        status: row.status,
        requestedAt: row.createdAt,
        kycStatus: player?.kycStatus ? normalizeKycStatus(player.kycStatus) : null,
        riskTags: riskTags.get(row.id) ?? [],
      };
    });
  }

  private async withdrawalRiskTags(
    withdrawals: readonly Pick<WalletTransaction, 'id' | 'walletId' | 'amount' | 'currency'>[],
  ): Promise<Map<WalletTransaction['id'], WithdrawalRiskTag[]>> {
    const frequentWalletIds = await this.frequentWithdrawalWalletIds(
      this.drizzle.db,
      [...new Set(withdrawals.map((w) => w.walletId))],
      await this.getAutoWithdrawalConfigOrNull(),
    );
    const pivotCurrency = resolveExchangeRatePivot(this.platformConfig?.exchangeRate);
    const tags = await mapConcurrent(withdrawals, 5, async (w) => {
      const riskTags: WithdrawalRiskTag[] = [];
      const pivotAmount = await this.toPivotAmount(w.amount, w.currency, pivotCurrency);
      if (pivotAmount === null || moneyCompare(pivotAmount, LARGE_WITHDRAWAL_THRESHOLD) >= 0) {
        riskTags.push('large_amount');
      }
      if (frequentWalletIds.has(w.walletId)) {
        riskTags.push('high_frequency');
      }
      return [w.id, riskTags] as const;
    });
    return new Map(tags);
  }

  async approveWithdrawal(
    adminId: User['id'],
    withdrawalId: WalletTransaction['id'],
    meta?: ClientMeta,
  ): Promise<TransactionResult> {
    const owner = await this.withdrawalOwner(withdrawalId);
    const ownerId = owner.userId;
    const blocked = await this.approvalBlock(ownerId, owner);
    if (blocked) {
      throw blocked.error;
    }
    if (await this.isWithdrawalHeld(this.drizzle.db, ownerId)) {
      throw new WithdrawalHeldError();
    }
    const { queued, flipped } = await this.drizzle.db.transaction(async (txn) => {
      if (await this.isWithdrawalHeldLocked(txn, ownerId)) {
        throw new WithdrawalHeldError();
      }
      const decided = await this.flipToProcessing({
        txn,
        withdrawalId,
        adminId,
        from: QUEUED_WITHDRAWAL_STATUSES,
        reviewReason: null,
      });
      await this.events.emitInTransaction(txn, 'wallet.withdrawal.approved', {
        userId: ownerId,
        playerId: await this.identityReader.getPlayerIdByUserId(ownerId, txn),
        amount: decided.flipped.amount,
        currency: decided.flipped.currency,
        transactionId: decided.flipped.id,
        adminId,
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
      });
      return decided;
    });
    const blockedAfterFlip = await this.revertFlipIfBlocked(ownerId, queued);
    if (blockedAfterFlip) {
      throw blockedAfterFlip.error;
    }
    return this.settleApproved(flipped, queued, adminId);
  }

  private async flipToProcessing({
    txn,
    withdrawalId,
    adminId,
    from,
    reviewReason,
    autoApprovalPivotAmount,
  }: {
    txn: DrizzleTx;
    withdrawalId: WalletTransaction['id'];
    adminId: User['id'] | null;
    from: readonly WalletTransaction['status'][];
    reviewReason?: WalletTransaction['reviewReason'];
    autoApprovalPivotAmount?: string;
  }): Promise<{ queued: WalletTransaction; flipped: WalletTransaction }> {
    const current = findOneOrThrow(
      await txn
        .select()
        .from(walletTransaction)
        .where(eq(walletTransaction.id, withdrawalId))
        .for('update'),
      new WithdrawalNotFoundError(withdrawalId),
    );
    assertWithdrawalIn(current, from);
    const flipped = findOneOrThrow(
      await txn
        .update(walletTransaction)
        .set({
          status: 'processing',
          reviewedBy: adminId,
          reviewedAt: new Date(),
          ...(reviewReason !== undefined ? { reviewReason } : {}),
          ...(autoApprovalPivotAmount !== undefined ? { autoApprovalPivotAmount } : {}),
        })
        .where(eq(walletTransaction.id, withdrawalId))
        .returning(),
      new WithdrawalNotFoundError(withdrawalId),
    );
    return { queued: current, flipped };
  }

  private async isWithdrawalHeldLocked(txn: DrizzleTx, userId: User['id']): Promise<boolean> {
    await txn.select({ id: wallet.id }).from(wallet).where(eq(wallet.userId, userId)).for('share');
    return this.isWithdrawalHeld(txn, userId);
  }

  private async revertFlipIfBlocked(userId: User['id'], queued: WalletTransaction) {
    const blocked = await this.approvalBlock(userId, queued).catch((err: unknown) => {
      logger.error({ err, transactionId: queued.id }, 'withdrawal control check failed after flip');
      return {
        reason: 'control_check_failed' as const,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    });
    if (!blocked) {
      return null;
    }
    const playerId = await this.identityReader.getPlayerIdByUserIdSafe(userId);
    await this.drizzle.db.transaction((txn) =>
      this.restoreQueued(txn, queued, { userId, playerId, reason: blocked.reason }),
    );
    return blocked;
  }

  async requeueNeverDispatched(
    transactionId: WalletTransaction['id'],
    approvedBefore: Date,
  ): Promise<boolean> {
    return this.drizzle.db.transaction(async (txn) => {
      const [stranded] = await txn
        .select({ tx: walletTransaction, userId: wallet.userId })
        .from(walletTransaction)
        .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
        .where(
          and(
            eq(walletTransaction.id, transactionId),
            eq(walletTransaction.type, 'withdrawal'),
            eq(walletTransaction.status, 'processing'),
            isNull(walletTransaction.providerName),
            lt(
              sql`coalesce(${walletTransaction.reviewedAt}, ${walletTransaction.createdAt})`,
              approvedBefore,
            ),
          ),
        )
        .for('update', { of: walletTransaction });
      if (!stranded) {
        return false;
      }
      const { tx, userId } = stranded;
      const playerId = await this.identityReader.getPlayerIdByUserIdSafe(userId);
      return this.restoreQueued(
        txn,
        {
          ...tx,
          status: 'pending',
          reviewedBy: null,
          reviewedAt: null,
          reviewReason: null,
          autoApprovalPivotAmount: null,
        },
        { userId, playerId, reason: 'never_dispatched' },
      );
    });
  }

  private async restoreQueued(
    txn: DrizzleTx,
    queued: WalletTransaction,
    {
      userId,
      playerId,
      reason,
    }: { userId: User['id']; playerId: Player['id'] | null; reason: WithdrawalRequeueReason },
  ): Promise<boolean> {
    const [restored] = await txn
      .update(walletTransaction)
      .set({
        status: queued.status,
        reviewedBy: queued.reviewedBy,
        reviewedAt: queued.reviewedAt,
        reviewReason: queued.reviewReason,
        autoApprovalPivotAmount: queued.autoApprovalPivotAmount,
      })
      .where(
        and(
          eq(walletTransaction.id, queued.id),
          eq(walletTransaction.status, 'processing'),
          isNull(walletTransaction.providerName),
        ),
      )
      .returning({ id: walletTransaction.id });
    if (!restored) {
      return false;
    }
    await this.audit.recordInTransaction(txn, {
      actorType: 'system',
      action: 'wallet.withdrawal.requeued',
      ...withdrawalAuditSubject(playerId, queued.id),
      before: { status: 'processing' },
      after: { userId, transactionId: queued.id, status: queued.status, reason },
    });
    await this.events.emitInTransaction(txn, 'wallet.withdrawal.requeued', {
      userId,
      playerId,
      amount: queued.amount,
      currency: queued.currency,
      transactionId: queued.id,
      reason,
    });
    return true;
  }

  private async settleApproved(
    tx: WalletTransaction,
    queued: WalletTransaction,
    adminId: User['id'] | null,
  ): Promise<TransactionResult> {
    const userId = await this.userIdForWallet(tx.walletId);
    const playerId = await this.identityReader.getPlayerIdByUserIdSafe(userId);
    const amount = tx.amount;

    const { providerName, adapter } = await this.paymentAdapterFor(tx.currency, tx.network);
    const dispatch = await this.drizzle.db.transaction(async (txn) => {
      if (await this.isWithdrawalHeldLocked(txn, userId)) {
        await this.restoreQueued(txn, queued, { userId, playerId, reason: 'withdrawal_hold' });
        return 'held' as const;
      }
      const stamped = await txn
        .update(walletTransaction)
        .set({ providerName })
        .where(
          and(
            eq(walletTransaction.id, tx.id),
            eq(walletTransaction.status, 'processing'),
            isNull(walletTransaction.providerName),
          ),
        )
        .returning({ id: walletTransaction.id });
      return stamped.length > 0 ? ('stamped' as const) : ('gone' as const);
    });
    if (dispatch === 'held') {
      throw new WithdrawalHeldError();
    }
    if (dispatch === 'gone') {
      logger.warn({ transactionId: tx.id }, 'withdrawal left processing before dispatch, not paid');
      return this.withdrawalResult(tx.id);
    }

    let result: Awaited<ReturnType<PaymentAdapter['processWithdrawal']>>;
    try {
      result = await adapter.processWithdrawal(payoutAmount(tx), tx.currency, {
        transactionId: tx.id,
        userId,
        rail: tx.rail,
        adminId,
        destinationAddress: tx.destinationAddress,
        destinationTag: tx.destinationTag,
        ...(tx.destinationWalletId ? { destinationWalletId: tx.destinationWalletId } : {}),
        network: tx.network,
      });
    } catch (err) {
      if (err instanceof PaymentRejectedError) {
        await this.finalizeFailedWithdrawal({ tx, adminId, userId, playerId, amount });
        throw err;
      }
      logger.error(
        { err, transactionId: tx.id, providerName },
        'withdrawal outcome unknown - held in processing for reconciliation',
      );
      try {
        await this.audit.record({
          actorType: adminId ? 'admin' : 'system',
          actorId: adminId,
          action: 'wallet.withdrawal.outcome_unknown',
          ...withdrawalAuditSubject(playerId, tx.id),
          after: { userId, transactionId: tx.id, amount, currency: tx.currency, providerName },
        });
      } catch (auditErr) {
        logger.error({ err: auditErr, transactionId: tx.id }, 'outcome_unknown audit write failed');
      }
      return { transactionId: tx.id, status: 'processing' };
    }

    if (result.status === 'failed') {
      await this.finalizeFailedWithdrawal({ tx, adminId, userId, playerId, amount });
      return { transactionId: tx.id, status: 'failed' };
    }

    if (result.status !== 'completed') {
      await this.drizzle.db
        .update(walletTransaction)
        .set({
          providerName,
          providerRefId: result.externalId,
        })
        .where(eq(walletTransaction.id, tx.id));
      return { transactionId: tx.id, status: 'processing' };
    }

    const completed = await this.drizzle.db.transaction(async (txn) => {
      const updated = await txn
        .update(walletTransaction)
        .set({
          status: 'completed',
          providerName,
          providerRefId: result.externalId,
        })
        .where(and(eq(walletTransaction.id, tx.id), eq(walletTransaction.status, 'processing')))
        .returning({ id: walletTransaction.id });
      if (updated.length === 0) {
        return false;
      }
      await this.events.emitInTransaction(txn, 'wallet.withdrawal.completed', {
        userId,
        playerId,
        amount,
        currency: tx.currency,
        transactionId: tx.id,
      });
      return true;
    });
    if (!completed) {
      return this.withdrawalResult(tx.id);
    }

    return { transactionId: tx.id, status: 'completed' };
  }

  private async withdrawalResult(id: WalletTransaction['id']): Promise<TransactionResult> {
    const [current] = await this.drizzle.db
      .select({ status: walletTransaction.status })
      .from(walletTransaction)
      .where(eq(walletTransaction.id, id));
    return { transactionId: id, status: current?.status ?? 'processing' };
  }

  private async finalizeFailedWithdrawal({
    tx,
    adminId,
    userId,
    playerId,
    amount,
  }: {
    tx: WalletTransaction;
    adminId: User['id'] | null;
    userId: User['id'];
    playerId: Player['id'] | null;
    amount: string;
  }): Promise<void> {
    await this.drizzle.db.transaction(async (txn) => {
      const updated = await txn
        .update(walletTransaction)
        .set({ status: 'failed' })
        .where(and(eq(walletTransaction.id, tx.id), eq(walletTransaction.status, 'processing')))
        .returning({ id: walletTransaction.id });
      if (updated.length === 0) {
        return;
      }
      await creditWalletBalance(txn, tx.walletId, tx.currency, amount);
      await this.audit.recordInTransaction(txn, {
        actorType: adminId ? 'admin' : 'system',
        actorId: adminId,
        action: 'wallet.withdrawal.failed',
        ...withdrawalAuditSubject(playerId, tx.id),
        after: { userId, transactionId: tx.id, amount, currency: tx.currency, reason: null },
      });
      await this.events.emitInTransaction(txn, 'wallet.withdrawal.failed', {
        userId,
        playerId,
        amount,
        currency: tx.currency,
        transactionId: tx.id,
        adminId,
      });
    });
  }

  async reconcileWithdrawalStatus(
    event: Extract<PaymentWebhookEvent, { kind: 'withdrawal' }>,
    providerName: string = DEFAULT_PAYMENT_PROVIDER,
  ): Promise<void> {
    const { externalId, status, txHash } = event;
    const [tx] = await this.drizzle.db
      .select()
      .from(walletTransaction)
      .where(
        and(
          eq(walletTransaction.providerName, providerName),
          eq(walletTransaction.providerRefId, externalId),
        ),
      );
    if (!tx || tx.type !== 'withdrawal') {
      logger.warn(
        { externalId, providerName },
        'payment webhook: no matching withdrawal for providerRefId',
      );
      return;
    }
    if (tx.status !== 'processing') {
      return;
    }

    const userId = await this.userIdForWallet(tx.walletId);
    const playerId = await this.identityReader.getPlayerIdByUserIdSafe(userId);

    if (status === 'completed') {
      await this.drizzle.db.transaction(async (txn) => {
        const updated = await txn
          .update(walletTransaction)
          .set({ status: 'completed', txHash: txHash ?? tx.txHash })
          .where(and(eq(walletTransaction.id, tx.id), eq(walletTransaction.status, 'processing')))
          .returning({ id: walletTransaction.id });
        if (updated.length === 0) {
          return;
        }
        await this.events.emitInTransaction(txn, 'wallet.withdrawal.completed', {
          userId,
          playerId,
          amount: tx.amount,
          currency: tx.currency,
          transactionId: tx.id,
        });
      });
      return;
    }

    if (status === 'failed') {
      await this.finalizeFailedWithdrawal({
        tx,
        adminId: null,
        userId,
        playerId,
        amount: tx.amount,
      });
    }
  }

  private async maybeAutoApprove(args: {
    userId: User['id'];
    amount: string;
    currency: string;
    transactionId: WalletTransaction['id'];
    walletId: Wallet['id'];
    rail: WalletRail;
    reviewRequired: boolean | undefined;
  }): Promise<TransactionResult | undefined> {
    if (!this.platformConfig?.autoWithdrawal?.enabled) {
      return undefined;
    }

    try {
      const cfg = this.platformConfig.autoWithdrawal;

      const gates = await this.evaluateAutoApproval(args);
      if (!gates) {
        return undefined;
      }

      const decided = await this.drizzle.db.transaction((txn) =>
        withAdvisoryXactLock(txn, args.userId, async () => {
          const caps = await this.autoApprovalCaps(
            { walletId: args.walletId, pivotAmount: gates.pivotAmount, cfg },
            txn,
          );
          if (caps.exceeded) {
            logger.info(
              { userId: args.userId, walletId: args.walletId, gate: 'daily_cap' },
              'auto-withdrawal skipped',
            );
            return null;
          }
          if (await this.isWithdrawalHeldLocked(txn, args.userId)) {
            logger.info(
              { userId: args.userId, walletId: args.walletId, gate: 'withdrawal_hold' },
              'auto-withdrawal skipped',
            );
            return null;
          }
          const { queued, flipped } = await this.flipToProcessing({
            txn,
            withdrawalId: args.transactionId,
            adminId: null,
            from: ['pending'],
            reviewReason: AUTO_APPROVED_REASON,
            autoApprovalPivotAmount: gates.pivotAmount,
          });
          return { tx: flipped, queued, caps };
        }),
      );
      if (!decided) {
        return undefined;
      }
      const blocked = await this.revertFlipIfBlocked(args.userId, decided.queued);
      if (blocked) {
        logger.info(
          { userId: args.userId, walletId: args.walletId, gate: blocked.reason },
          'auto-withdrawal skipped',
        );
        return undefined;
      }

      const decision: AutoApprovalDecision = {
        ...gates,
        dailyCapAmount: cfg.dailyCapAmount ?? null,
        dailyCapCount: cfg.dailyCapCount ?? null,
        cumulativeAmountUsed: decided.caps.amountUsed,
        cumulativeCountUsed: decided.caps.countUsed,
      };

      try {
        await this.audit.record({
          actorType: 'system',
          action: 'wallet.withdrawal.auto_approved',
          ...withdrawalAuditSubject(
            await this.identityReader.getPlayerIdByUserIdSafe(args.userId),
            args.transactionId,
          ),
          after: {
            userId: args.userId,
            transactionId: args.transactionId,
            amount: args.amount,
            currency: args.currency,
            reviewRequired: args.reviewRequired ?? null,
            ...decision,
          },
        });
      } catch (err) {
        await this.drizzle.db
          .update(walletTransaction)
          .set({
            status: 'pending',
            reviewedBy: null,
            reviewedAt: null,
            reviewReason: null,
            autoApprovalPivotAmount: null,
          })
          .where(eq(walletTransaction.id, args.transactionId));
        throw err;
      }

      try {
        return await this.settleApproved(decided.tx, decided.queued, null);
      } catch (err) {
        if (err instanceof PaymentRejectedError) {
          return { transactionId: args.transactionId, status: 'failed' };
        }
        if (err instanceof WithdrawalHeldError) {
          logger.info(
            { userId: args.userId, walletId: args.walletId, gate: 'withdrawal_hold' },
            'auto-withdrawal skipped',
          );
          return undefined;
        }
        throw err;
      }
    } catch (err) {
      logger.error({ err, transactionId: args.transactionId }, 'auto-withdrawal evaluation failed');
      return undefined;
    }
  }

  private async evaluateAutoApproval({
    userId,
    amount,
    currency,
    transactionId,
    walletId,
    rail,
    reviewRequired,
  }: {
    userId: User['id'];
    amount: string;
    currency: string;
    transactionId: WalletTransaction['id'];
    walletId: Wallet['id'];
    rail: WalletRail;
    reviewRequired: boolean | undefined;
  }): Promise<AutoApprovalGates | null> {
    const skip = (gate: string): null => {
      logger.info({ userId, walletId, gate }, 'auto-withdrawal skipped');
      return null;
    };
    const cfg = this.platformConfig?.autoWithdrawal;
    if (!cfg?.enabled) {
      return skip('disabled');
    }
    const threshold = await this.resolveAutoThreshold(userId, rail);
    if (!threshold || moneyCompare(threshold.value, '0') <= 0) {
      return skip('no_threshold');
    }
    const pivotCurrency = resolveExchangeRatePivot(this.platformConfig?.exchangeRate);
    const pivotAmount = await this.toPivotAmount(amount, currency, pivotCurrency);
    if (pivotAmount === null || moneyCompare(pivotAmount, threshold.value) > 0) {
      return skip('over_threshold');
    }

    const kycRequired = await this.withdrawalNeedsKyc(userId, pivotAmount, pivotCurrency);
    const kycStatus = await this.autoApprovalKycStatus(userId);
    if (kycRequired && !isKycPassed(kycStatus)) {
      return skip('kyc');
    }

    const effectiveExcludeTags = threshold.config.excludeRiskFlags;
    if (reviewRequired !== false && effectiveExcludeTags.includes('withdrawal_review')) {
      return skip('review_required');
    }

    const riskTags = await this.autoApprovalRiskTags(userId);
    if (riskTags.includes(WITHDRAWAL_LOCK_TAG)) {
      return skip('withdrawal_lock');
    }
    if (await this.destinationIsUnmatured(transactionId, userId, currency)) {
      return skip('new_address');
    }
    if (riskTags.some((t) => effectiveExcludeTags.includes(t))) {
      return skip('risk_tag');
    }

    const heuristics = await this.autoApprovalHeuristics({
      walletId,
      amount: pivotAmount,
      config: threshold.config,
    });
    if (heuristics.largeAmount || heuristics.highFrequency) {
      return skip('heuristics');
    }

    return {
      threshold: threshold.value,
      thresholdSource: threshold.source,
      kycRequired,
      kycStatus,
      riskTagsEvaluated: riskTags,
      effectiveExcludeTags,
      pivotAmount,
      pivotCurrency,
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

  async getAutoWithdrawalConfig(): Promise<WalletAutoWithdrawalConfig> {
    const config = await this.getAutoWithdrawalConfigOrNull();
    if (!config) {
      throw new AutoWithdrawalConfigNotFoundError('global');
    }
    return config;
  }

  async getAutoWithdrawalConfigOrNull(): Promise<WalletAutoWithdrawalConfig | null> {
    const [row] = await this.drizzle.db
      .select()
      .from(walletAutoWithdrawalConfig)
      .where(eq(walletAutoWithdrawalConfig.singletonKey, 'global'));
    return row ? toAutoWithdrawalConfigDto(row) : null;
  }

  async setAutoWithdrawalConfig(
    adminId: User['id'],
    {
      fiatThreshold,
      cryptoThreshold,
      excludeRiskFlags,
      velocityCount,
      velocityWindowHours,
    }: {
      fiatThreshold: string;
      cryptoThreshold: string;
      excludeRiskFlags: TagKey[];
      velocityCount: number | null;
      velocityWindowHours: number;
    },
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
          velocityCount,
          velocityWindowHours,
          updatedBy: adminId,
        })
        .onConflictDoUpdate({
          target: walletAutoWithdrawalConfig.singletonKey,
          set: {
            fiatThreshold,
            cryptoThreshold,
            excludeRiskFlags,
            velocityCount,
            velocityWindowHours,
            updatedBy: adminId,
          },
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
              velocityCount: before.velocityCount,
              velocityWindowHours: before.velocityWindowHours,
            }
          : null,
        after: {
          fiatThreshold: config.fiatThreshold,
          cryptoThreshold: config.cryptoThreshold,
          excludeRiskFlags: config.excludeRiskFlags,
          velocityCount: config.velocityCount,
          velocityWindowHours: config.velocityWindowHours,
        },
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

  private assertAdapterSupports(currency: string, network: string, providerName?: string) {
    const adapter =
      (providerName ? this.paymentProviders.get(providerName)?.adapter : undefined) ?? this.payment;
    if (adapter.supportsAsset && !adapter.supportsAsset(currency, network)) {
      throw new WalletAssetUnsupportedError();
    }
  }

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
    this.assertProviderNameValid(input.providerName);
    this.assertAdapterSupports(input.currency, input.network, input.providerName);
    return this.drizzle.db.transaction(async (txn) => {
      const rows = await txn.insert(walletAsset).values(input).onConflictDoNothing().returning();
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

  async updateWalletAsset(
    adminId: User['id'],
    { currency, network, ...changes }: UpdateWalletAssetInput,
    meta?: ClientMeta,
  ): Promise<WalletAsset> {
    return this.drizzle.db.transaction(async (txn) => {
      const [before] = await txn
        .select()
        .from(walletAsset)
        .where(and(eq(walletAsset.currency, currency), eq(walletAsset.network, network)))
        .for('update');
      if (!before) {
        throw new WalletAssetNotFoundError(`${currency}/${network}`);
      }
      if (changes.providerAssetId !== undefined) {
        this.assertAdapterSupports(currency, network, before.providerName ?? undefined);
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
        .where(and(eq(walletAsset.currency, currency), eq(walletAsset.network, network)))
        .for('update');
      if (!before) {
        return false;
      }
      const held = await txn
        .select({ id: walletBalance.id })
        .from(walletBalance)
        .where(and(eq(walletBalance.currency, currency), sql`${walletBalance.amount} > 0`))
        .for('update');
      if (held.length > 0) {
        throw new WalletAssetInUseError();
      }
      const [issued] = await txn
        .select({ n: count() })
        .from(walletDepositAddress)
        .where(
          and(
            eq(walletDepositAddress.currency, currency),
            eq(walletDepositAddress.network, network),
          ),
        );
      if ((issued?.n ?? 0) > 0) {
        throw new WalletAssetHasIssuedAddressesError();
      }
      const [inFlight] = await txn
        .select({ n: count() })
        .from(walletTransaction)
        .where(
          and(
            eq(walletTransaction.currency, currency),
            eq(walletTransaction.network, network),
            inArray(walletTransaction.status, [...IN_FLIGHT_TRANSACTION_STATUSES]),
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

  private async destinationIsUnmatured(
    transactionId: WalletTransaction['id'],
    userId: User['id'],
    currency: string,
  ): Promise<boolean> {
    const [tx] = await this.drizzle.db
      .select({
        address: walletTransaction.destinationAddress,
        tag: walletTransaction.destinationTag,
        network: walletTransaction.network,
      })
      .from(walletTransaction)
      .where(eq(walletTransaction.id, transactionId));
    if (!tx?.address) {
      return false;
    }
    const saved = await this.findSavedWithdrawalAddress(
      userId,
      currency,
      tx.network,
      tx.address,
      tx.tag,
    );
    return !saved || saved.createdAt.getTime() + WITHDRAWAL_ADDRESS_COOLDOWN_MS > Date.now();
  }

  private async autoApprovalKycStatus(userId: User['id']): Promise<KycStatus | null> {
    if (!this.directory) {
      return null;
    }
    const [summary] = await this.directory.lookupPlayers([userId]);
    return summary?.kycStatus ?? null;
  }

  private async autoApprovalRiskTags(userId: User['id']): Promise<TagKey[]> {
    const byUser = await this.riskTags.getActiveTagKeys([userId]);
    return byUser.get(userId) ?? [];
  }

  private async autoApprovalHeuristics({
    walletId,
    amount,
    config,
  }: {
    walletId: Wallet['id'];
    amount: string;
    config: WalletAutoWithdrawalConfig;
  }): Promise<{ largeAmount: boolean; highFrequency: boolean }> {
    const frequent = await this.frequentWithdrawalWalletIds(this.drizzle.db, [walletId], config);
    return {
      largeAmount: moneyCompare(amount, LARGE_WITHDRAWAL_THRESHOLD) >= 0,
      highFrequency: frequent.has(walletId),
    };
  }

  private async frequentWithdrawalWalletIds(
    db: DrizzleDb | DrizzleTx,
    walletIds: string[],
    config: WalletAutoWithdrawalConfig | null,
  ): Promise<Set<string>> {
    const frequent = new Set<string>();
    const minCount = config?.velocityCount;
    if (walletIds.length === 0 || !minCount) {
      return frequent;
    }
    const since = new Date(Date.now() - config.velocityWindowHours * 60 * 60 * 1000);
    const counts = await db
      .select({ walletId: walletTransaction.walletId, n: count() })
      .from(walletTransaction)
      .where(
        and(
          eq(walletTransaction.type, 'withdrawal'),
          gte(walletTransaction.createdAt, since),
          inArray(walletTransaction.walletId, walletIds),
          notInArray(walletTransaction.status, [...VELOCITY_IGNORED_STATUSES]),
        ),
      )
      .groupBy(walletTransaction.walletId);
    for (const row of counts) {
      if (Number(row.n) >= minCount) {
        frequent.add(row.walletId);
      }
    }
    return frequent;
  }

  private async autoApprovalCaps(
    {
      walletId,
      pivotAmount,
      cfg,
    }: {
      walletId: Wallet['id'];
      pivotAmount: string;
      cfg: NonNullable<PlatformConfig['autoWithdrawal']>;
    },
    db: DrizzleTx,
  ): Promise<{ exceeded: boolean; amountUsed: string | null; countUsed: number }> {
    const since = new Date(Date.now() - DAILY_CAP_WINDOW_MS);
    const [row] = await db
      .select({
        total: sql<string>`coalesce(sum(${walletTransaction.autoApprovalPivotAmount}), 0)`,
        n: count(),
        priced: count(walletTransaction.autoApprovalPivotAmount),
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
    const countUsed = row?.n ?? 0;
    const amountUsed = (row?.priced ?? 0) < countUsed ? null : (row?.total ?? '0');
    const amountExceeded =
      cfg.dailyCapAmount !== undefined &&
      (amountUsed === null ||
        moneyCompare(moneyAdd(amountUsed, pivotAmount), cfg.dailyCapAmount) > 0);
    const countExceeded = cfg.dailyCapCount !== undefined && countUsed + 1 > cfg.dailyCapCount;
    return { exceeded: amountExceeded || countExceeded, amountUsed, countUsed };
  }

  private async toPivotAmount(
    amount: string,
    currency: string,
    pivotCurrency: string,
  ): Promise<string | null> {
    if (currency.toUpperCase() === pivotCurrency) {
      return amount;
    }
    return this.rates ? this.rates.convert(amount, currency, pivotCurrency) : null;
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
      assertWithdrawalIn(current, QUEUED_WITHDRAWAL_STATUSES);
      const updated = findOneOrThrow(
        await txn
          .update(walletTransaction)
          .set({ status: 'rejected', reviewedBy: adminId, reviewedAt, reviewReason: reason })
          .where(eq(walletTransaction.id, withdrawalId))
          .returning(),
        new WithdrawalNotFoundError(withdrawalId),
      );

      await creditWalletBalance(txn, updated.walletId, updated.currency, updated.amount);

      const userId = await this.userIdForWallet(updated.walletId, txn);
      await this.events.emitInTransaction(txn, 'wallet.withdrawal.rejected', {
        userId,
        playerId: await this.identityReader.getPlayerIdByUserId(userId, txn),
        amount: updated.amount,
        currency: updated.currency,
        transactionId: updated.id,
        adminId,
        reason,
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
      });

      return updated;
    });

    return { transactionId: tx.id, status: 'rejected' };
  }

  async getPlayerWithdrawalStatus({
    userId,
    withdrawalId,
  }: {
    userId: User['id'];
    withdrawalId: WalletTransaction['id'];
  }) {
    const [row] = await this.drizzle.db
      .select({ status: walletTransaction.status })
      .from(walletTransaction)
      .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
      .where(playerWithdrawal(userId, withdrawalId));
    return row?.status ?? null;
  }

  async holdWithdrawal({
    adminId,
    userId,
    withdrawalId,
    reason,
    proposalId,
  }: {
    adminId: User['id'];
    userId: User['id'];
    withdrawalId: WalletTransaction['id'];
    reason: string;
    proposalId: ActionExecutionContext['proposalId'];
  }) {
    const playerId = await this.identityReader.getPlayerIdByUserIdSafe(userId);
    return this.drizzle.db.transaction(async (txn) => {
      const current = findOneOrThrow(
        await txn
          .select({ status: walletTransaction.status })
          .from(walletTransaction)
          .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
          .where(playerWithdrawal(userId, withdrawalId))
          .for('update', { of: walletTransaction }),
        new WithdrawalNotFoundError(withdrawalId),
      );
      if (current.status === 'on_hold') {
        return { changed: false };
      }
      if (current.status !== 'pending') {
        throw new WithdrawalNotPendingError();
      }
      await txn
        .update(walletTransaction)
        .set({
          status: 'on_hold',
          reviewedBy: adminId,
          reviewedAt: new Date(),
          reviewReason: reason,
        })
        .where(eq(walletTransaction.id, withdrawalId));
      await this.audit.recordInTransaction(txn, {
        actorId: adminId,
        actorType: 'admin',
        action: 'wallet.withdrawal.held',
        ...withdrawalAuditSubject(playerId, withdrawalId),
        before: { status: 'pending' },
        after: { userId, transactionId: withdrawalId, status: 'on_hold', reason, proposalId },
      });
      return { changed: true };
    });
  }

  async getTransactions({
    userId,
    page,
    limit,
    sortBy,
    sortOrder,
    amountCurrency,
    types,
    statuses,
    currencies,
    from,
    to,
    search,
    products,
    includeInternal = false,
    includeGrants = false,
  }: PaginationOptions<
    { userId: User['id']; includeInternal?: boolean; includeGrants?: boolean } & Omit<
      WalletTransactionListQuery,
      'page' | 'limit' | 'sortBy' | 'sortOrder'
    >,
    WalletTransactionSortBy
  >) {
    const t = walletTransaction;
    const ledgerRows = sql`
      select ${t.id} as id, ${t.type}::text as type, ${t.amount} as amount,
        ${t.currency} as currency, ${t.network} as network, ${t.status}::text as status,
        ${t.direction}::text as direction, ${t.createdAt} as created_at, ${t.rail}::text as rail,
        ${t.reviewedBy} as reviewed_by, ${t.reviewedAt} as reviewed_at,
        ${t.reviewReason} as review_reason, ${t.referenceCurrency} as reference_currency,
        ${t.referenceAmount} as reference_amount, ${t.referenceRate} as reference_rate,
        ${t.referenceRateAsOf} as reference_rate_as_of, ${t.providerRefId} as provider_ref_id,
        ${t.txHash} as tx_hash, ${t.fee} as fee, ${t.providerName} as provider_name,
        ${t.balanceAfter} as balance_after, ${t.metadata} as metadata
      from ${t}
      where ${t.walletId} in (select ${wallet.id} from ${wallet} where ${wallet.userId} = ${userId})`;
    const grantQuery =
      includeGrants && this.grantLedger
        ? (this.grantLedger.ledgerRowsQuery(userId) as SQL)
        : undefined;
    const grantRows = grantQuery
      ? sql`
      union all
      select g.id, g.type, g.amount, g.currency, null, g.status, 'credit', g.created_at, null,
        null, null, null, null, null, null, null, null, null, null, null, null, null
      from (${grantQuery}) g`
      : sql``;
    const history = sql`(${ledgerRows} ${grantRows}) as history`;

    const conditions: SQL[] = [];
    if (types?.length) {
      conditions.push(sql`type = any(${sql.param(types)}::text[])`);
    }
    if (statuses?.length) {
      conditions.push(sql`status = any(${sql.param(statuses)}::text[])`);
    }
    if (currencies?.length) {
      conditions.push(sql`currency = any(${sql.param(currencies)}::text[])`);
    }
    if (from) {
      conditions.push(sql`created_at >= ${from}::timestamptz`);
    }
    if (to) {
      conditions.push(sql`created_at <= ${to}::timestamptz`);
    }
    if (products?.length) {
      const prefixes = products.map((p) => `${escapeLike(wagerProductProviderPrefix(p))}%`);
      conditions.push(sql`provider_name like any(${sql.param(prefixes)}::text[])`);
    }
    if (search) {
      conditions.push(
        sql`(id::text like ${`${escapeLike(search.toLowerCase())}%`} or provider_ref_id = ${search} or tx_hash = ${search})`,
      );
    }
    const where = conditions.length ? sql`where ${sql.join(conditions, sql` and `)}` : sql``;
    const dir = (sortOrder ?? 'desc') === 'asc' ? sql`asc` : sql`desc`;
    const db = this.drizzle.db;

    let source = history;
    let orderBy = sql`${sql.identifier(TX_SORT_COLUMNS[sortBy ?? 'createdAt'])} ${dir}`;
    if (sortBy === 'amount' && amountCurrency) {
      const rates = await this.amountSortRates(history, amountCurrency);
      source = sql`${history} left join unnest(${sql.param(rates.map((r) => r.currency))}::text[],
        ${sql.param(rates.map((r) => r.rate))}::numeric[]) as r(currency, rate) using (currency)`;
      orderBy = sql`(case when direction = 'debit' then -amount else amount end) * rate ${dir} nulls last`;
    }

    const [{ rows }, { rows: counted }] = await Promise.all([
      db.execute<TransactionHistoryRow>(sql`
        select * from ${source} ${where}
        order by ${orderBy}, id desc
        limit ${limit} offset ${pageToOffset(page, limit)}`),
      db.execute<{ n: number }>(sql`select count(*)::int as n from ${history} ${where}`),
    ]);
    return {
      items: rows.map((tx) => ({
        id: tx.id,
        type: tx.type,
        amount: tx.amount,
        currency: tx.currency,
        network: tx.network,
        status: tx.status,
        direction: tx.direction,
        fee: tx.fee,
        balanceAfter: includeInternal ? tx.balance_after : null,
        createdAt: new Date(tx.created_at).toISOString(),
        reviewedBy: includeInternal ? tx.reviewed_by : null,
        reviewedAt:
          includeInternal && tx.reviewed_at ? new Date(tx.reviewed_at).toISOString() : null,
        reviewReason:
          includeInternal || MANUAL_ADJUSTMENT_TYPES.has(tx.type) ? tx.review_reason : null,
        product: wagerProductOfProviderName(tx.provider_name),
        reference: includeInternal
          ? toReferenceDto({
              referenceCurrency: tx.reference_currency,
              referenceAmount: tx.reference_amount,
              referenceRate: tx.reference_rate,
              referenceRateAsOf: tx.reference_rate_as_of ? new Date(tx.reference_rate_as_of) : null,
            })
          : null,
        claimId: includeInternal && tx.type === 'cashback' ? claimIdOf(tx.metadata) : null,
      })),
      total: counted[0]?.n ?? 0,
      page,
      limit,
    };
  }

  private async amountSortRates(history: SQL, target: string) {
    if (!resolveDisplayCurrencies(this.platformConfig?.displayCurrencies).includes(target)) {
      throw new UnsupportedAmountCurrencyError(target);
    }
    const { rows } = await this.drizzle.db.execute<{ currency: string }>(
      sql`select distinct currency from ${history}`,
    );
    return mapConcurrent(rows, 5, async ({ currency }) => ({
      currency,
      rate:
        currency.toUpperCase() === target
          ? '1'
          : ((await this.rates?.getRate(currency, target))?.rate ?? null),
    }));
  }

  async assertDepositAdmitted(userId: User['id']): Promise<void> {
    await this.assertDepositPlayable(userId);
    await this.assertDepositPolicyAdmits(userId);
  }

  private async assertDepositPlayable(userId: User['id'], txn?: DrizzleTx): Promise<void> {
    const refusal = await this.playRefusal(userId, txn);
    if (refusal) {
      throw new DepositRefusedError(refusal);
    }
  }

  private async assertDepositPolicyAdmits(userId: User['id']): Promise<void> {
    const reason = await this.depositAdmission?.refusalReason(userId);
    if (typeof reason === 'string') {
      throw new DepositRefusedError(reason);
    }
  }

  private async playRefusal(userId: User['id'], txn?: DrizzleTx): Promise<string | null> {
    if (!this.playEligibility) {
      return null;
    }
    if (this.playEligibility.checkPlay) {
      return this.playEligibility.checkPlay(userId, txn);
    }
    return (await this.playEligibility.isRestricted(userId, txn)) ? 'restricted' : null;
  }

  async getOrCreateDepositAddress(
    userId: User['id'],
    currency: string,
    network?: string,
  ): Promise<DepositAddressResult> {
    await this.assertDepositAdmitted(userId);
    await this.assertDepositable(currency, undefined, network);

    const existing = await this.findDepositAddress(userId, currency, network);
    if (existing) {
      return toDepositAddressResult(existing);
    }
    const { providerName, adapter } = await this.paymentAdapterFor(currency, network ?? null);
    if (!adapter.issueDepositAddress) {
      throw new DepositAddressUnsupportedError();
    }
    const issued = await adapter.issueDepositAddress(userId, currency, network);

    const [row] = await this.drizzle.db.transaction(async (txn) => {
      await this.assertDepositable(currency, undefined, network, txn);
      return txn
        .insert(walletDepositAddress)
        .values({
          userId,
          currency,
          network: network ?? null,
          address: issued.address,
          tag: issued.tag ?? null,
          providerName,
        })
        .onConflictDoNothing()
        .returning();
    });
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

  async creditDepositByAddress(
    event: Extract<PaymentWebhookEvent, { kind: 'deposit' }>,
    providerName: string = DEFAULT_PAYMENT_PROVIDER,
  ): Promise<void> {
    assertRecordableDeposit(event);
    const depositAddress = await this.findDepositAddressByAddress(event);
    if (!depositAddress) {
      logger.warn(
        { address: event.address, network: event.network, tag: event.tag },
        'payment webhook: no wallet_deposit_address for inbound deposit',
      );
      await recordReconciliationFinding(
        this.drizzle.db,
        {
          runId: OUT_OF_CYCLE_RUN_ID,
          providerName,
          kind: 'unattributed_deposit',
          currency: event.currency,
          network: event.network ?? null,
          amount: event.amount,
          address: event.address,
          tag: event.tag ?? null,
          txHash: event.txHash,
          sourceAddress: event.sourceAddress ?? null,
          externalId: event.externalId,
          detail: 'no wallet_deposit_address matched this address/network/tag',
        },
        this.audit,
      );
      return;
    }
    if (isAddressCurrencyMismatch(event, depositAddress)) {
      logger.warn(
        {
          address: event.address,
          eventCurrency: event.currency,
          addressCurrency: depositAddress.currency,
        },
        'payment webhook: currency mismatch for inbound deposit',
      );
      await recordReconciliationFinding(
        this.drizzle.db,
        {
          runId: OUT_OF_CYCLE_RUN_ID,
          providerName: depositAddress.providerName,
          kind: 'currency_mismatch',
          currency: event.currency,
          network: event.network ?? depositAddress.network,
          amount: event.amount,
          address: event.address,
          tag: event.tag ?? null,
          txHash: event.txHash,
          sourceAddress: event.sourceAddress ?? null,
          externalId: event.externalId,
          detail: `currency mismatch: event reported ${event.currency}, address issued for ${depositAddress.currency}`,
        },
        this.audit,
      );
      return;
    }

    const playerId = await this.identityReader.getPlayerIdByUserIdSafe(depositAddress.userId);
    const credit = await this.drizzle.db.transaction(async (txn) => {
      await lockVendorDeposit(txn, depositAddress.providerName, event.externalId);
      if (await isRefundedDeposit(txn, depositAddress.providerName, event.externalId)) {
        return null;
      }
      const [credited] = await this.findDepositByProviderRef(
        txn,
        depositAddress.providerName,
        event.externalId,
      );
      if (credited) {
        return {
          transactionId: credited.id,
          holdReason: heldReason(credited),
          refunded: credited.status === 'refunded',
        };
      }
      if (await this.refuseIfBelowMinimum(txn, { event, depositAddress, playerId })) {
        return 'below_minimum' as const;
      }
      let [walletRecord] = await txn
        .select()
        .from(wallet)
        .where(eq(wallet.userId, depositAddress.userId));
      if (!walletRecord) {
        walletRecord = await openWallet(txn, depositAddress.userId, event.currency);
      }
      const reference = await this.referenceSnapshot(
        txn,
        depositAddress.userId,
        event.amount,
        event.currency,
      );
      const holdReason = await this.depositHoldReason(txn, depositAddress.userId, event);
      const [inserted] = await txn
        .insert(walletTransaction)
        .values({
          ...reference,
          walletId: walletRecord.id,
          type: 'deposit',
          amount: event.amount,
          currency: event.currency,
          status: holdReason === null ? 'completed' : 'on_hold',
          reviewReason: holdReason,
          direction: 'credit',
          rail: this.resolveRail(event.currency),
          network: event.network ?? depositAddress.network,
          providerName: depositAddress.providerName,
          providerRefId: event.externalId,
          destinationAddress: event.address,
          txHash: event.txHash,
        })
        .onConflictDoNothing()
        .returning();

      if (inserted) {
        const payload = {
          userId: depositAddress.userId,
          playerId,
          amount: event.amount,
          currency: event.currency,
          transactionId: inserted.id,
        };
        if (holdReason === null) {
          await creditAndStampBalance(
            txn,
            inserted.id,
            walletRecord.id,
            event.currency,
            event.amount,
          );
          await this.depositCompleted(txn, payload);
        } else {
          await recordReconciliationFindingInTransaction(
            txn,
            {
              runId: OUT_OF_CYCLE_RUN_ID,
              providerName: depositAddress.providerName,
              kind: 'held_deposit',
              currency: event.currency,
              network: event.network ?? depositAddress.network,
              amount: event.amount,
              address: event.address,
              tag: event.tag ?? null,
              txHash: event.txHash,
              sourceAddress: event.sourceAddress ?? null,
              externalId: event.externalId,
              transactionId: inserted.id,
              detail: `held, not credited: ${holdReason}`,
            },
            this.audit,
          );
          await this.events.emitInTransaction(txn, 'wallet.deposit.held', payload);
        }
        return { transactionId: inserted.id, holdReason, refunded: false };
      }

      const [winner] = await this.findDepositByProviderRef(
        txn,
        depositAddress.providerName,
        event.externalId,
      );
      if (!winner) {
        throw new Error(
          `payment webhook: idempotency conflict but no row found (externalId=${event.externalId})`,
        );
      }
      return {
        transactionId: winner.id,
        holdReason: heldReason(winner),
        refunded: winner.status === 'refunded',
      };
    });
    if (credit === 'below_minimum') {
      return;
    }
    if (credit === null) {
      logger.warn(
        { userId: depositAddress.userId, externalId: event.externalId },
        'payment webhook: deposit was already refunded on chain, not credited',
      );
      return;
    }
    const { transactionId, holdReason, refunded } = credit;

    if (refunded) {
      logger.warn(
        { userId: depositAddress.userId, transactionId, externalId: event.externalId },
        'payment webhook: redelivered deposit was already refunded, not credited',
      );
      return;
    }

    if (holdReason !== null) {
      logger.warn(
        { userId: depositAddress.userId, transactionId, externalId: event.externalId },
        'payment webhook: on-chain deposit held for review, not credited',
      );
      return;
    }

    const rgDecision = await rgDecisionForLandedCredit(
      this.drizzle.db,
      this.rgLimits,
      { userId: depositAddress.userId, attempted: '0', currency: event.currency },
      { externalId: event.externalId, txHash: event.txHash },
    );
    if (rgDecision) {
      await recordReconciliationFinding(
        this.drizzle.db,
        {
          runId: OUT_OF_CYCLE_RUN_ID,
          providerName: depositAddress.providerName,
          kind: 'rg_limit_breach',
          currency: event.currency,
          network: event.network ?? depositAddress.network,
          amount: event.amount,
          address: event.address,
          tag: event.tag ?? null,
          txHash: event.txHash,
          externalId: event.externalId,
          transactionId,
          detail: `credited past the player's ${rgDecision.period} ${rgDecision.limitType} limit of ${rgDecision.limit} (${rgDecision.used} in the window, this deposit included) - the funds were already on chain`,
        },
        this.audit,
      );
    }
  }

  async recordDepositStatus(event: DepositStatusEvent): Promise<void> {
    assertRecordableDeposit(event);
    const depositAddress = await this.findAttributableDepositAddress(event);
    if (!depositAddress || isAddressCurrencyMismatch(event, depositAddress)) {
      logger.warn(
        { externalId: event.externalId, network: event.network, status: event.status },
        'payment webhook: deposit status event names no single player or its address is in another currency, ignored',
      );
      return;
    }
    const playerId = await this.identityReader.getPlayerIdByUserIdSafe(depositAddress.userId);
    const { providerName } = depositAddress;
    await this.drizzle.db.transaction(async (txn) => {
      await lockVendorDeposit(txn, providerName, event.externalId);
      if (await this.isDepositSettled(txn, providerName, event.externalId)) {
        return;
      }
      const seen = await this.depositStatusesSeen(txn, providerName, event.externalId);
      if (depositStatusIsNoOp(seen, event.status)) {
        return;
      }
      await this.recordDepositOutcome(txn, event.status, {
        event,
        network: await this.reportedNetwork(event, txn),
        depositAddress,
        playerId,
        detail: event.vendorStatus ? { vendorStatus: event.vendorStatus } : {},
      });
    });
  }

  async recordDepositIfBelowMinimum(event: DepositEvent): Promise<boolean> {
    const depositAddress = await this.findAttributableDepositAddress(event);
    if (!depositAddress || isAddressCurrencyMismatch(event, depositAddress)) {
      return false;
    }
    const playerId = await this.identityReader.getPlayerIdByUserIdSafe(depositAddress.userId);
    const { providerName } = depositAddress;
    return this.drizzle.db.transaction(async (txn) => {
      await lockVendorDeposit(txn, providerName, event.externalId);
      if (await this.isDepositSettled(txn, providerName, event.externalId)) {
        return false;
      }
      return this.refuseIfBelowMinimum(txn, { event, depositAddress, playerId });
    });
  }

  private async refuseIfBelowMinimum(
    txn: DrizzleTx,
    deposit: Omit<DepositOutcome, 'event' | 'network' | 'detail'> & { event: DepositEvent },
  ): Promise<boolean> {
    const { event, depositAddress } = deposit;
    const { providerName } = depositAddress;
    const seen = await this.depositStatusesSeen(txn, providerName, event.externalId);
    if (seen.has('below_minimum')) {
      return true;
    }
    const network = await this.reportedNetwork(event, txn);
    const assets = await this.selectDepositAssets(event.currency, txn);
    const floor = depositFloor(assets, network ?? undefined) ?? depositFloor(assets);
    const refused =
      !isPositiveMoney(event.amount) ||
      (floor !== undefined && moneyCompare(event.amount, floor.minDeposit) < 0);
    if (!refused) {
      return false;
    }
    await this.recordDepositOutcome(txn, 'below_minimum', {
      ...deposit,
      network,
      detail: { minDeposit: floor?.minDeposit ?? null },
    });
    await recordReconciliationFindingInTransaction(
      txn,
      {
        runId: OUT_OF_CYCLE_RUN_ID,
        providerName,
        kind: 'below_minimum_deposit',
        currency: event.currency,
        network,
        amount: event.amount,
        address: event.address,
        tag: event.tag ?? null,
        txHash: event.txHash,
        sourceAddress: event.sourceAddress ?? null,
        externalId: event.externalId,
        detail: floor ? `asset minimum ${floor.minDeposit}` : null,
      },
      this.audit,
    );
    return true;
  }

  private async isDepositSettled(
    txn: DrizzleTx,
    providerName: string,
    externalId: WalletDepositStatusEvent['externalId'],
  ) {
    if (await isRefundedDeposit(txn, providerName, externalId)) {
      return true;
    }
    const [row] = await this.findDepositByProviderRef(txn, providerName, externalId);
    return row !== undefined;
  }

  private async reportedNetwork(
    event: DepositAddressTarget & Pick<DepositEvent, 'currency'>,
    db: DrizzleTx,
  ) {
    return (
      event.network ??
      soleNetworkForCurrency(await this.depositAddressRows(event, db), event.currency) ??
      null
    );
  }

  private async depositStatusesSeen(
    txn: DrizzleTx,
    providerName: string,
    externalId: WalletDepositStatusEvent['externalId'],
  ) {
    const rows = await txn
      .select({ status: walletDepositStatusEvent.status })
      .from(walletDepositStatusEvent)
      .where(
        and(
          eq(walletDepositStatusEvent.providerName, providerName),
          eq(walletDepositStatusEvent.externalId, externalId),
        ),
      );
    return new Set(rows.map((row) => row.status));
  }

  private async recordDepositOutcome(
    txn: DrizzleTx,
    status: WalletDepositStatusEventStatus,
    { event, network, depositAddress, playerId, detail }: DepositOutcome,
  ) {
    const { providerName } = depositAddress;
    const { externalId, amount, currency } = event;
    const [inserted] = await txn
      .insert(walletDepositStatusEvent)
      .values({ providerName, externalId, status })
      .onConflictDoNothing()
      .returning({ id: walletDepositStatusEvent.id });
    if (!inserted) {
      return;
    }
    await this.audit.recordInTransaction(txn, {
      actorType: 'system',
      action: `wallet.deposit.${status}`,
      resourceType: playerId ? 'player' : 'user',
      resourceId: playerId ?? depositAddress.userId,
      ...(status === 'detected' ? {} : { result: 'failure' }),
      after: {
        providerName,
        externalId,
        amount,
        currency,
        network,
        ...detail,
      },
    });
  }

  async releaseHeldDeposit(
    txn: DrizzleTx,
    depositId: WalletTransaction['id'],
    adminId: User['id'],
  ): Promise<{ userId: User['id']; amount: string; currency: string }> {
    const [held] = await txn
      .select({
        walletId: walletTransaction.walletId,
        amount: walletTransaction.amount,
        currency: walletTransaction.currency,
        userId: wallet.userId,
      })
      .from(walletTransaction)
      .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
      .where(
        and(
          eq(walletTransaction.id, depositId),
          eq(walletTransaction.type, 'deposit'),
          eq(walletTransaction.status, 'on_hold'),
        ),
      )
      .for('update', { of: walletTransaction });
    if (!held) {
      throw new HeldDepositNotFoundError();
    }
    if (!this.depositHold) {
      throw new DepositStillHeldError('no deposit hold policy is bound to re-check it');
    }
    const reason = await this.depositHoldReason(txn, held.userId, held);
    if (reason !== null) {
      throw new DepositStillHeldError(reason);
    }
    await txn
      .update(walletTransaction)
      .set({ status: 'completed', reviewedBy: adminId, reviewedAt: sql`now()` })
      .where(eq(walletTransaction.id, depositId));
    await creditAndStampBalance(txn, depositId, held.walletId, held.currency, held.amount);
    return { userId: held.userId, amount: held.amount, currency: held.currency };
  }

  async creditDepositByHand(
    txn: DrizzleTx,
    deposit: HandDeposit,
  ): Promise<{
    transactionId: WalletTransaction['id'];
    userId: User['id'];
    amount: string;
    currency: string;
  }> {
    if (!(await this.identityReader.getPlayerIdByUserId(deposit.userId))) {
      throw new PlayerNotFoundError(deposit.userId);
    }
    const reason = await this.depositHoldReason(txn, deposit.userId, deposit);
    if (reason !== null) {
      throw new DepositStillHeldError(reason);
    }
    const reference = await this.referenceSnapshot(
      txn,
      deposit.userId,
      deposit.amount,
      deposit.currency,
    );
    const row = await this.insertHandDeposit(txn, deposit, { ...reference, status: 'completed' });
    await creditAndStampBalance(txn, row.id, row.walletId, deposit.currency, deposit.amount);
    return {
      transactionId: row.id,
      userId: deposit.userId,
      amount: deposit.amount,
      currency: deposit.currency,
    };
  }

  async recordRefundedDeposit(
    txn: DrizzleTx,
    deposit: HandDeposit & { providerRefId: string },
  ): Promise<WalletTransaction['id']> {
    const row = await this.insertHandDeposit(txn, deposit, { status: 'refunded' });
    return row.id;
  }

  async depositAddressOwner(target: DepositAddressTarget): Promise<User['id'] | undefined> {
    return (await this.findDepositAddressByAddress(target))?.userId;
  }

  private async insertHandDeposit(
    txn: DrizzleTx,
    deposit: HandDeposit,
    values: Partial<typeof walletTransaction.$inferInsert> & {
      status: 'completed' | 'refunded';
    },
  ): Promise<WalletTransaction> {
    const walletRecord = await openWallet(txn, deposit.userId, deposit.currency);
    const [row] = await txn
      .insert(walletTransaction)
      .values({
        ...values,
        walletId: walletRecord.id,
        type: 'deposit',
        amount: deposit.amount,
        currency: deposit.currency,
        direction: 'credit',
        rail: this.resolveRail(deposit.currency),
        network: deposit.network,
        providerName: deposit.providerName,
        providerRefId: deposit.providerRefId,
        destinationAddress: deposit.address,
        destinationTag: deposit.tag,
        txHash: deposit.txHash,
        reviewedBy: deposit.adminId,
        reviewedAt: sql`now()`,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      throw new DepositAlreadyOnLedgerError();
    }
    return row;
  }

  async announceDepositCompleted(
    txn: DrizzleTx,
    deposit: {
      userId: User['id'];
      amount: string;
      currency: string;
      transactionId: WalletTransaction['id'];
    },
  ): Promise<void> {
    await this.depositCompleted(txn, {
      ...deposit,
      playerId: await this.identityReader.getPlayerIdByUserId(deposit.userId, txn),
    });
  }

  async depositHoldReason(
    txn: DrizzleTx,
    userId: User['id'],
    deposit: { amount: string; currency: string },
  ): Promise<string | null> {
    const policy = this.depositHold;
    if (!policy) {
      return null;
    }
    return withAdvisoryXactLock(txn, depositSlotKey(userId), () =>
      policy.holdReason(txn, { userId, amount: deposit.amount, currency: deposit.currency }),
    );
  }

  private findDepositByProviderRef(
    txn: DrizzleTx,
    providerName: string,
    externalId: NonNullable<WalletTransaction['providerRefId']>,
  ) {
    return txn
      .select({
        id: walletTransaction.id,
        status: walletTransaction.status,
        reviewReason: walletTransaction.reviewReason,
      })
      .from(walletTransaction)
      .where(
        and(
          eq(walletTransaction.providerName, providerName),
          eq(walletTransaction.providerRefId, externalId),
        ),
      );
  }

  private async userIdForWallet(
    walletId: Wallet['id'],
    txn: DrizzleDb | DrizzleTx = this.drizzle.db,
  ) {
    const record = findOneOrThrow(
      await txn.select({ userId: wallet.userId }).from(wallet).where(eq(wallet.id, walletId)),
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

  private async findAttributableDepositAddress(target: DepositAddressTarget) {
    try {
      return await this.findDepositAddressByAddress(target);
    } catch (err) {
      if (err instanceof AmbiguousDepositAddressError) {
        return undefined;
      }
      throw err;
    }
  }

  private depositAddressRows(
    { address, network, tag }: DepositAddressTarget,
    db: DrizzleDb | DrizzleTx = this.drizzle.db,
  ) {
    return db
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
  }

  private async findDepositAddressByAddress(target: DepositAddressTarget) {
    const { address, network, currency } = target;
    const rows = await this.depositAddressRows(target);

    const owners = new Set(rows.map((row) => row.userId));
    if (owners.size > 1) {
      throw new AmbiguousDepositAddressError(address, network);
    }
    return (
      rows.find((row) => row.network === network) ??
      rows.find((row) => row.currency.toUpperCase() === currency?.toUpperCase()) ??
      rows[0]
    );
  }

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
    await this.rateLimit(userId);

    const reserved = await this.drizzle.db.transaction((txn) =>
      withAdvisoryXactLock(txn, `withdrawal-address-cap:${userId}`, async () => {
        const [existing] = await txn
          .select({ total: count() })
          .from(walletWithdrawalAddress)
          .where(eq(walletWithdrawalAddress.userId, userId));
        if ((existing?.total ?? 0) >= WITHDRAWAL_ADDRESS_LIMIT) {
          throw new WithdrawalAddressLimitReachedError(WITHDRAWAL_ADDRESS_LIMIT);
        }

        const [inserted] = await txn
          .insert(walletWithdrawalAddress)
          .values({ userId, ...input })
          .onConflictDoNothing()
          .returning();
        if (!inserted) {
          throw new WithdrawalAddressAlreadyExistsError();
        }
        return inserted;
      }),
    );

    let whitelisted: Awaited<ReturnType<typeof this.whitelistWithdrawalAddress>>;
    try {
      whitelisted = await this.whitelistWithdrawalAddress(userId, input);
    } catch (err) {
      await this.releaseWithdrawalAddressSlot(reserved.id);
      throw err;
    }

    const [updated] = Object.keys(whitelisted).length
      ? await this.drizzle.db
          .update(walletWithdrawalAddress)
          .set(whitelisted)
          .where(eq(walletWithdrawalAddress.id, reserved.id))
          .returning()
      : [];
    const row = updated ?? reserved;

    await this.audit.record({
      actorId: userId,
      actorType: 'player',
      action: 'wallet.withdrawal_address.created',
      resourceType: 'wallet_withdrawal_address',
      resourceId: row.id,
      after: { label: row.label, currency: row.currency, network: row.network },
      ...meta,
    });
    try {
      await this.mailDispatch?.toUser({
        userId,
        template: {
          key: 'withdrawalAddressAdded',
          data: {
            address: row.address,
            network: row.network,
            occurredAt: row.createdAt.toISOString(),
          },
        },
        idempotencyKey: `withdrawal-address-added:${row.id}`,
      });
    } catch (err) {
      logger.error({ err, withdrawalAddressId: row.id }, 'new withdrawal address notice failed');
    }
    return toWithdrawalAddressDto(row);
  }

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

  private async releaseWithdrawalAddressSlot(id: WithdrawalAddress['id']): Promise<void> {
    try {
      await this.drizzle.db
        .delete(walletWithdrawalAddress)
        .where(eq(walletWithdrawalAddress.id, id));
    } catch (err) {
      logger.error({ err, withdrawalAddressId: id }, 'withdrawal address slot release failed');
    }
  }

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
