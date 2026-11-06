import * as z from 'zod';
import {
  CurrencyTickerSchema,
  KycStatusSchema,
  MoneyAmountSchema,
  NonEmptyReasonSchema,
  SignedMoneyAmountSchema,
  TagKeySchema,
  TimestampSchema,
  UuidSchema,
  WalletTransactionStatusSchema,
  defineActionType,
  defineMcpTool,
  type WalletTransactionStatus,
} from '@openora/core/contracts';

export const OPEN_WITHDRAWALS_LIMIT = 20;

// A withdrawal still waiting on a decision: the queue summary counts and totals only these, and
// an admin may approve or reject only these.
export const QUEUED_WITHDRAWAL_STATUSES = [
  'pending',
  'on_hold',
] as const satisfies readonly WalletTransactionStatus[];
export const QueuedWithdrawalStatusSchema = z.enum(QUEUED_WITHDRAWAL_STATUSES);
export type QueuedWithdrawalStatus = z.infer<typeof QueuedWithdrawalStatusSchema>;

export const WITHDRAWAL_RISK_TAGS = ['large_amount', 'high_frequency'] as const;
export const WithdrawalRiskTagSchema = z.enum(WITHDRAWAL_RISK_TAGS);
export type WithdrawalRiskTag = z.infer<typeof WithdrawalRiskTagSchema>;

export const WalletActivityInputSchema = z.object({
  playerId: UuidSchema,
  windowDays: z.coerce.number().int().min(1).max(365).default(30),
});
export type WalletActivityInput = z.infer<typeof WalletActivityInputSchema>;

export const WalletActivityOutputSchema = z.object({
  playerId: UuidSchema,
  windowDays: z.number().int(),
  activeCurrency: CurrencyTickerSchema,
  balances: z.array(z.object({ currency: CurrencyTickerSchema, balance: MoneyAmountSchema })),
  totals: z.array(
    z.object({
      currency: CurrencyTickerSchema,
      deposits: MoneyAmountSchema,
      depositCount: z.number().int().nonnegative(),
      withdrawals: MoneyAmountSchema,
      withdrawalCount: z.number().int().nonnegative(),
      bets: MoneyAmountSchema,
      wins: MoneyAmountSchema,
    }),
  ),
  openWithdrawals: z
    .array(
      z.object({
        withdrawalId: UuidSchema,
        amount: MoneyAmountSchema,
        currency: CurrencyTickerSchema,
        status: WalletTransactionStatusSchema,
        requestedAt: TimestampSchema,
      }),
    )
    .max(OPEN_WITHDRAWALS_LIMIT),
});
export type WalletActivity = z.infer<typeof WalletActivityOutputSchema>;

export const walletActivityTool = defineMcpTool({
  id: 'wallet.activity',
  title: 'Wallet activity',
  description:
    "A player's balances, their completed deposits, withdrawals, bets and wins (net of reversed " +
    'payouts) per currency over the last windowDays days, and the withdrawals still awaiting a ' +
    'decision (pending or ' +
    'on hold, newest first). Use it to judge recent money movement, and to find the ' +
    'withdrawalId a hold_withdrawal proposal needs. Amounts are decimal strings.',
  class: 'read',
  schemaVersion: 1,
  iam: { resource: 'transaction', action: 'view' },
  inputSchema: WalletActivityInputSchema,
  outputSchema: WalletActivityOutputSchema,
  redact: {
    allow: ['playerId', 'windowDays', 'activeCurrency', 'balances', 'totals', 'openWithdrawals'],
  },
  errors: ['player_not_found'],
});

export const WITHDRAWAL_QUEUE_MAX_ITEMS = 20;
export const WITHDRAWAL_QUEUE_MAX_CURRENCIES = 100;

export const WithdrawalsQueueInputSchema = z.object({
  status: QueuedWithdrawalStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(WITHDRAWAL_QUEUE_MAX_ITEMS).default(10),
});
export type WithdrawalsQueueInput = z.infer<typeof WithdrawalsQueueInputSchema>;

export const WithdrawalsQueueOutputSchema = z.object({
  pendingCount: z.number().int().nonnegative(),
  onHoldCount: z.number().int().nonnegative(),
  queuedTotals: z
    .array(z.object({ currency: CurrencyTickerSchema, amount: MoneyAmountSchema }))
    .max(WITHDRAWAL_QUEUE_MAX_CURRENCIES),
  avgPendingWaitHours: z.number().nonnegative().nullable(),
  oldest: z
    .array(
      z.object({
        withdrawalId: UuidSchema,
        playerId: UuidSchema.nullable(),
        amount: MoneyAmountSchema,
        currency: CurrencyTickerSchema,
        status: WalletTransactionStatusSchema,
        requestedAt: TimestampSchema,
        waitHours: z.number().nonnegative(),
        kycStatus: KycStatusSchema.nullable(),
        riskTags: z.array(WithdrawalRiskTagSchema).max(WITHDRAWAL_RISK_TAGS.length),
      }),
    )
    .max(WITHDRAWAL_QUEUE_MAX_ITEMS),
});
export type WithdrawalsQueue = z.infer<typeof WithdrawalsQueueOutputSchema>;

export const withdrawalsQueueTool = defineMcpTool({
  id: 'withdrawals.queue',
  title: 'Withdrawal queue',
  description:
    'The withdrawal queue across all players: how many withdrawals wait for a decision, pending ' +
    'or on_hold (held for manual review, AML holds included), their totals per currency (at most ' +
    '100), the average hours the pending ones have waited, and the ones waiting longest, oldest ' +
    'first (limit 1 to 20, default 10; status narrows them to pending or on_hold). Each carries ' +
    'its withdrawalId and playerId, amount, currency, status, request time, hours waited, the ' +
    "player's KYC status and risk tags: large_amount (5000 or more in the fx pivot currency, or " +
    'no rate to price it) and high_frequency (as many recent withdrawal requests as the ' +
    'auto-approval velocity check counts as frequent). Use wallet.activity or player.summary for ' +
    "one player's detail. Amounts are decimal strings and never summed across currencies.",
  class: 'read',
  schemaVersion: 1,
  iam: { resource: 'withdrawal', action: 'view' },
  inputSchema: WithdrawalsQueueInputSchema,
  outputSchema: WithdrawalsQueueOutputSchema,
  redact: {
    allow: ['pendingCount', 'onHoldCount', 'queuedTotals', 'avgPendingWaitHours', 'oldest'],
  },
  errors: [],
});

export const DEPOSIT_COMPARE_MAX_WINDOW_DAYS = 92;
export const DEPOSIT_COMPARE_MAX_PLAYERS = 50;
export const DEPOSIT_COMPARE_MAX_SEGMENT = 20_000;

export const DEPOSIT_COMPARE_ORDERS = ['largest_drop', 'largest_rise'] as const;
export const DepositCompareOrderSchema = z.enum(DEPOSIT_COMPARE_ORDERS);
export type DepositCompareOrder = z.infer<typeof DepositCompareOrderSchema>;

const DAY_MS = 24 * 60 * 60 * 1000;

export const DepositWindowSchema = z.object({ from: z.iso.date(), to: z.iso.date() });
export type DepositWindow = z.infer<typeof DepositWindowSchema>;

function checkDepositWindow(
  { from, to }: DepositWindow,
  key: 'windowA' | 'windowB',
  ctx: z.core.$RefinementCtx,
) {
  if (from > to) {
    ctx.addIssue({ code: 'custom', path: [key, 'from'], message: 'from must be on or before to' });
    return;
  }
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS + 1 > DEPOSIT_COMPARE_MAX_WINDOW_DAYS) {
    ctx.addIssue({
      code: 'custom',
      path: [key, 'from'],
      message: `a window spans at most ${DEPOSIT_COMPARE_MAX_WINDOW_DAYS} days`,
    });
  }
}

export const DepositCompareInputSchema = z
  .object({
    tag: TagKeySchema,
    windowA: DepositWindowSchema,
    windowB: DepositWindowSchema,
    order: DepositCompareOrderSchema.default('largest_drop'),
    limit: z.coerce.number().int().min(1).max(DEPOSIT_COMPARE_MAX_PLAYERS).default(20),
  })
  .superRefine((input, ctx) => {
    checkDepositWindow(input.windowA, 'windowA', ctx);
    checkDepositWindow(input.windowB, 'windowB', ctx);
  });
export type DepositCompareInput = z.infer<typeof DepositCompareInputSchema>;

export const PlayerDepositChangeSchema = z.object({
  playerId: UuidSchema,
  depositsA: MoneyAmountSchema,
  depositsB: MoneyAmountSchema,
  change: SignedMoneyAmountSchema,
  changePct: z.number().nullable(),
});
export type PlayerDepositChange = z.infer<typeof PlayerDepositChangeSchema>;

export const DepositCompareOutputSchema = z.object({
  tag: TagKeySchema,
  playersInSegment: z.number().int().nonnegative(),
  pivotCurrency: CurrencyTickerSchema,
  totals: z.object({ windowA: MoneyAmountSchema, windowB: MoneyAmountSchema }),
  players: z.array(PlayerDepositChangeSchema).max(DEPOSIT_COMPARE_MAX_PLAYERS),
  unpricedPlayers: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type DepositCompare = z.infer<typeof DepositCompareOutputSchema>;

export const playersDepositCompareTool = defineMcpTool({
  id: 'players.deposit_compare',
  title: 'Segment deposit comparison',
  description:
    'Compares the completed deposits of the players holding a tag (eg vip) between two windows ' +
    'of whole UTC days, windowA the baseline and windowB the comparison, each at most 92 days. A ' +
    'deposit counts on the day it reached the balance, and each player is priced into the fx ' +
    'pivot currency at the current rates. players lists at most 50 (limit, default 20) whose ' +
    'deposits fell (order largest_drop, the default) or rose (largest_rise), largest change ' +
    'first: change is depositsB minus depositsA, changePct is that as a percentage of depositsA ' +
    '(null when it is 0); truncated is true when more players qualified. totals sums both ' +
    'windows over every priced player of the segment. A player with a deposit in a currency ' +
    'that has no rate is left out of both and counted in unpricedPlayers. A segment of more ' +
    'than 20000 players is refused as segment_too_large. Amounts are decimal strings.',
  class: 'read',
  schemaVersion: 1,
  iam: { resource: 'transaction', action: 'view' },
  inputSchema: DepositCompareInputSchema,
  outputSchema: DepositCompareOutputSchema,
  redact: {
    allow: [
      'tag',
      'playersInSegment',
      'pivotCurrency',
      'totals',
      'players',
      'unpricedPlayers',
      'truncated',
    ],
  },
  errors: ['segment_too_large'],
});

export const HoldWithdrawalPayloadSchema = z.object({
  playerId: UuidSchema,
  withdrawalId: UuidSchema,
  reason: NonEmptyReasonSchema.max(500),
});
export type HoldWithdrawalPayload = z.infer<typeof HoldWithdrawalPayloadSchema>;

export const holdWithdrawalAction = defineActionType({
  id: 'hold_withdrawal',
  title: 'Hold a withdrawal',
  description:
    "Holds a player's pending withdrawal for manual review, so it is not paid out " +
    'automatically. The funds stay held on the withdrawal; an admin later approves or rejects ' +
    'it. Only a pending withdrawal of the named player can be held.',
  schemaVersion: 1,
  iam: { resource: 'withdrawal', action: 'hold' },
  reversible: true,
  // Each withdrawal is held on its own: a pending hold on one does not cover another.
  distinctBy: 'withdrawalId',
  payloadSchema: HoldWithdrawalPayloadSchema,
  errors: ['player_not_found', 'withdrawal_not_found', 'withdrawal_not_pending'],
});
