import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  KycStatusSchema,
  MoneyAmountSchema,
  MONEY_PRECISION,
  MONEY_SCALE,
  TagKeySchema,
  TimestampSchema,
  UuidSchema,
  WalletRailSchema,
  WalletTransactionStatusSchema,
  WalletTransactionTypeSchema,
} from '@openora/core/contracts';
import { PageQuerySchema, SortOrderSchema, paginated } from '@openora/core/contracts/kit';

export { WalletRailSchema, WalletTransactionStatusSchema, WalletTransactionTypeSchema };

// Deposit/withdraw amounts must be strictly positive; balances/thresholds may be zero.
const PositiveMoneyAmountSchema = MoneyAmountSchema.refine((v) => Number(v) > 0, {
  message: 'must be greater than zero',
});

// ISO 4217 plus longer crypto tickers (USDT, USDC). Codes are canonically uppercase -
// normalize on the way in so a `usd` request can never diverge from a `USD` wallet.
const WalletCurrencyCodeSchema = z
  .string()
  .regex(/^[A-Za-z]{3,10}$/, 'currency code, e.g. USD or USDT');

const WalletCurrencyInputSchema = WalletCurrencyCodeSchema.transform((c) => c.toUpperCase());

// A currency does not identify a chain: USDT settles on ERC20, TRC20 and BEP20 with
// different addresses, fees and minimums. Free-form rather than an enum because each
// vendor spells chains its own way (ERC20 vs ETHEREUM vs eth-mainnet).
const WalletNetworkSchema = z.string().trim().min(1).max(32);

const WalletNetworkInputSchema = WalletNetworkSchema.transform((n) => n.toUpperCase());

export const WalletBalanceSchema = z.object({
  balance: MoneyAmountSchema,
  currency: WalletCurrencyCodeSchema,
});

export const WalletBalancesSchema = z.object({
  activeCurrency: WalletCurrencyCodeSchema,
  balances: z.array(WalletBalanceSchema),
});

export const SetActiveCurrencyInputSchema = z.object({ currency: WalletCurrencyCodeSchema });

export const ActiveCurrencySchema = z.object({ activeCurrency: WalletCurrencyCodeSchema });

export const WalletTransactionSchema = z.object({
  id: UuidSchema,
  type: WalletTransactionTypeSchema,
  amount: MoneyAmountSchema,
  currency: WalletCurrencyCodeSchema,
  network: WalletNetworkSchema.nullable(),
  status: WalletTransactionStatusSchema,
  createdAt: TimestampSchema,
});

export const DepositInputSchema = z.object({
  amount: PositiveMoneyAmountSchema,
  currency: WalletCurrencyInputSchema,
  provider: z.string().optional(),
  idempotencyKey: UuidSchema.optional(),
});

export const WithdrawInputSchema = z.object({
  amount: PositiveMoneyAmountSchema,
  currency: WalletCurrencyInputSchema,
  // Required for any currency the operator settles on more than one chain - a payout is
  // rejected as ambiguous rather than guessing which chain the player meant.
  network: WalletNetworkInputSchema.optional(),
  provider: z.string().optional(),
  idempotencyKey: UuidSchema.optional(),
  destinationAddress: z.string().optional(),
});

export const TransactionResultSchema = z.object({
  transactionId: UuidSchema,
  status: WalletTransactionStatusSchema,
});
export type TransactionResult = z.infer<typeof TransactionResultSchema>;

export const WALLET_TX_SORT_BY_VALUES = [
  'createdAt',
  'amount',
  'type',
  'status',
  'currency',
  'rail',
  'reviewedAt',
] as const;
export const WalletTransactionSortBySchema = z.enum(WALLET_TX_SORT_BY_VALUES).default('createdAt');
export type WalletTransactionSortBy = z.infer<typeof WalletTransactionSortBySchema>;

export const WITHDRAWAL_SORT_BY_VALUES = [
  'createdAt',
  'amount',
  'status',
  'currency',
  'rail',
  'reviewedAt',
] as const;
export const WithdrawalSortBySchema = z.enum(WITHDRAWAL_SORT_BY_VALUES).default('createdAt');
export type WithdrawalSortBy = z.infer<typeof WithdrawalSortBySchema>;

export const ListPlayerTransactionsArgs = PageQuerySchema.extend({
  userId: UuidSchema,
  sortBy: WalletTransactionSortBySchema.optional(),
  sortOrder: SortOrderSchema.default('desc').optional(),
});

export const WithdrawalQueueItemSchema = z.object({
  transactionId: UuidSchema,
  userId: UuidSchema,
  playerId: UuidSchema.nullable(),
  username: z.string(),
  amount: MoneyAmountSchema,
  currency: WalletCurrencyCodeSchema,
  network: WalletNetworkSchema.nullable(),
  rail: WalletRailSchema.nullable(),
  status: WalletTransactionStatusSchema,
  kycStatus: KycStatusSchema.nullable(),
  riskTags: z.array(z.string()),
  requestedAt: TimestampSchema,
  destinationAddress: z.string().nullable(),
  txHash: z.string().nullable(),
});
export type WithdrawalQueueItem = z.infer<typeof WithdrawalQueueItemSchema>;

export const WithdrawalQueueFilterSchema = PageQuerySchema.extend({
  status: WalletTransactionStatusSchema.optional(),
  currency: WalletCurrencyInputSchema.optional(),
  rail: WalletRailSchema.optional(),
  minAmount: MoneyAmountSchema.optional(),
  maxAmount: MoneyAmountSchema.optional(),
  kycStatus: KycStatusSchema.optional(),
  dateFrom: TimestampSchema.optional(),
  dateTo: TimestampSchema.optional(),
  sortBy: WithdrawalSortBySchema.optional(),
  sortOrder: SortOrderSchema.default('desc').optional(),
});
export type WithdrawalQueueFilter = z.infer<typeof WithdrawalQueueFilterSchema>;

export const AutoWithdrawalRuleSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  threshold: MoneyAmountSchema,
  reason: z.string(),
  createdBy: UuidSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type AutoWithdrawalRule = z.infer<typeof AutoWithdrawalRuleSchema>;

export const SetAutoWithdrawalRuleInputSchema = z.object({
  userId: UuidSchema,
  threshold: PositiveMoneyAmountSchema,
  reason: z.string().min(1),
});

export const AutoWithdrawalRuleKeySchema = z.object({ userId: UuidSchema });

export const WalletAutoWithdrawalConfigSchema = z.object({
  id: UuidSchema,
  fiatThreshold: MoneyAmountSchema,
  cryptoThreshold: MoneyAmountSchema,
  excludeRiskFlags: z.array(TagKeySchema),
  updatedBy: UuidSchema.nullable(),
  updatedAt: TimestampSchema,
  createdAt: TimestampSchema,
});
export type WalletAutoWithdrawalConfig = z.infer<typeof WalletAutoWithdrawalConfigSchema>;

// wallet_auto_withdrawal_config.{fiatThreshold,cryptoThreshold} are decimal(18,8) - 10
// integer digits max. Bounded here (not in the shared MoneyAmountSchema, which also backs
// decimal(18,2) columns with a different integer-digit budget) so an out-of-range value is
// a 4xx at the contract boundary instead of a DB overflow 500.
const WalletAutoWithdrawalThresholdSchema = MoneyAmountSchema.refine(
  (v) => (v.split('.').at(0) ?? '').length <= 10,
  { message: 'must have at most 10 integer digits' },
);

export const SetWalletAutoWithdrawalConfigInputSchema = z.object({
  fiatThreshold: WalletAutoWithdrawalThresholdSchema,
  cryptoThreshold: WalletAutoWithdrawalThresholdSchema,
  excludeRiskFlags: z.array(TagKeySchema),
});

export const ApproveWithdrawalInputSchema = z.object({ withdrawalId: UuidSchema });

export const RejectWithdrawalInputSchema = z.object({
  withdrawalId: UuidSchema,
  reason: z.string().min(1),
});

export const PaymentWebhookInputSchema = z.record(z.string(), z.unknown());
export const PaymentWebhookOutputSchema = z.object({ ok: z.literal(true) });

export const DepositAddressInputSchema = z.object({
  currency: WalletCurrencyInputSchema,
  network: WalletNetworkInputSchema.optional(),
});
export const DepositAddressSchema = z.object({
  address: z.string(),
  currency: WalletCurrencyCodeSchema,
  network: WalletNetworkSchema.optional(),
  tag: z.string().optional(),
});

// Bounded to the column's integer-digit budget so an oversized value is a 4xx at the
// contract boundary instead of a DB overflow 500.
const WalletAssetAmountSchema = MoneyAmountSchema.refine(
  (v) => (v.split('.').at(0) ?? '').length <= MONEY_PRECISION - MONEY_SCALE,
  { message: `must have at most ${MONEY_PRECISION - MONEY_SCALE} integer digits` },
);

export const PublicWalletAssetSchema = z.object({
  currency: WalletCurrencyCodeSchema,
  network: WalletNetworkSchema,
  minDeposit: MoneyAmountSchema,
  minWithdrawal: MoneyAmountSchema,
  withdrawalFee: MoneyAmountSchema,
  depositEnabled: z.boolean(),
  withdrawalEnabled: z.boolean(),
});
export type PublicWalletAsset = z.infer<typeof PublicWalletAssetSchema>;

export const WalletAssetSchema = PublicWalletAssetSchema.extend({
  id: UuidSchema,
  providerAssetId: z.string(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type WalletAsset = z.infer<typeof WalletAssetSchema>;

export const WalletAssetKeySchema = z.object({
  currency: WalletCurrencyInputSchema,
  network: WalletNetworkInputSchema,
});

export const CreateWalletAssetInputSchema = z.object({
  currency: WalletCurrencyInputSchema,
  network: WalletNetworkInputSchema,
  providerAssetId: z.string().trim().min(1),
  minDeposit: WalletAssetAmountSchema,
  minWithdrawal: WalletAssetAmountSchema,
  withdrawalFee: WalletAssetAmountSchema,
  depositEnabled: z.boolean().default(true),
  withdrawalEnabled: z.boolean().default(true),
});
export type CreateWalletAssetInput = z.infer<typeof CreateWalletAssetInputSchema>;

// The (currency, network) key is not mutable: renaming a pair is a delete plus a create,
// so an in-flight vendor reference can't be rewritten out from under a pending transaction.
export const UpdateWalletAssetInputSchema = WalletAssetKeySchema.extend({
  providerAssetId: z.string().trim().min(1).optional(),
  minDeposit: WalletAssetAmountSchema.optional(),
  minWithdrawal: WalletAssetAmountSchema.optional(),
  withdrawalFee: WalletAssetAmountSchema.optional(),
  depositEnabled: z.boolean().optional(),
  withdrawalEnabled: z.boolean().optional(),
});
export type UpdateWalletAssetInput = z.infer<typeof UpdateWalletAssetInputSchema>;

export const walletContract = {
  getBalance: oc.route({ method: 'GET', path: '/wallet/balance' }).output(WalletBalanceSchema),

  getBalances: oc.route({ method: 'GET', path: '/wallet/balances' }).output(WalletBalancesSchema),

  setActiveCurrency: oc
    .route({ method: 'PUT', path: '/wallet/active-currency' })
    .input(SetActiveCurrencyInputSchema)
    .output(ActiveCurrencySchema),

  deposit: oc
    .route({ method: 'POST', path: '/wallet/deposit' })
    .input(DepositInputSchema)
    .output(TransactionResultSchema),

  withdraw: oc
    .route({ method: 'POST', path: '/wallet/withdraw' })
    .input(WithdrawInputSchema)
    .output(TransactionResultSchema),

  listTransactions: oc
    .route({ method: 'GET', path: '/wallet/transactions' })
    .input(
      PageQuerySchema.extend({
        sortBy: WalletTransactionSortBySchema.optional(),
        sortOrder: SortOrderSchema.default('desc').optional(),
      }),
    )
    .output(paginated(WalletTransactionSchema)),

  listPlayerTransactions: oc
    .route({ method: 'GET', path: '/wallet/transactions/{userId}' })
    .input(ListPlayerTransactionsArgs)
    .output(paginated(WalletTransactionSchema)),

  withdrawals: {
    list: oc
      .route({ method: 'GET', path: '/wallet/withdrawals' })
      .input(WithdrawalQueueFilterSchema)
      .output(paginated(WithdrawalQueueItemSchema)),

    approve: oc
      .route({ method: 'POST', path: '/wallet/withdrawals/{withdrawalId}/approve' })
      .input(ApproveWithdrawalInputSchema)
      .output(TransactionResultSchema),

    reject: oc
      .route({ method: 'POST', path: '/wallet/withdrawals/{withdrawalId}/reject' })
      .input(RejectWithdrawalInputSchema)
      .output(TransactionResultSchema),
  },

  autoWithdrawalRules: {
    set: oc
      .route({ method: 'PUT', path: '/wallet/auto-withdrawal-rules/{userId}' })
      .input(SetAutoWithdrawalRuleInputSchema)
      .output(AutoWithdrawalRuleSchema),

    get: oc
      .route({ method: 'GET', path: '/wallet/auto-withdrawal-rules/{userId}' })
      .input(AutoWithdrawalRuleKeySchema)
      .output(AutoWithdrawalRuleSchema.nullable()),

    delete: oc
      .route({ method: 'DELETE', path: '/wallet/auto-withdrawal-rules/{userId}' })
      .input(AutoWithdrawalRuleKeySchema)
      .output(z.boolean()),
  },

  autoWithdrawalConfig: {
    get: oc
      .route({ method: 'GET', path: '/wallet/auto-withdrawal-config' })
      .output(WalletAutoWithdrawalConfigSchema),

    set: oc
      .route({ method: 'PUT', path: '/wallet/auto-withdrawal-config' })
      .input(SetWalletAutoWithdrawalConfigInputSchema)
      .output(WalletAutoWithdrawalConfigSchema),
  },

  // Unauthenticated by design - which assets exist is not secret.
  listAssets: oc
    .route({ method: 'GET', path: '/wallet/assets' })
    .output(z.array(PublicWalletAssetSchema)),

  assets: {
    list: oc
      .route({ method: 'GET', path: '/wallet/admin/assets' })
      .output(z.array(WalletAssetSchema)),

    create: oc
      .route({ method: 'POST', path: '/wallet/admin/assets' })
      .input(CreateWalletAssetInputSchema)
      .output(WalletAssetSchema),

    update: oc
      .route({ method: 'PUT', path: '/wallet/admin/assets/{currency}/{network}' })
      .input(UpdateWalletAssetInputSchema)
      .output(WalletAssetSchema),

    delete: oc
      .route({ method: 'DELETE', path: '/wallet/admin/assets/{currency}/{network}' })
      .input(WalletAssetKeySchema)
      .output(z.boolean()),
  },

  deposits: {
    getAddress: oc
      .route({ method: 'POST', path: '/wallet/deposits/address' })
      .input(DepositAddressInputSchema)
      .output(DepositAddressSchema),
  },

  webhook: oc
    .route({ method: 'POST', path: '/wallet/webhook' })
    .input(PaymentWebhookInputSchema)
    .output(PaymentWebhookOutputSchema),
};
