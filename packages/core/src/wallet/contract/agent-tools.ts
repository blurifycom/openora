import * as z from 'zod';
import {
  CurrencyTickerSchema,
  MoneyAmountSchema,
  NonEmptyReasonSchema,
  TimestampSchema,
  UuidSchema,
  WalletTransactionStatusSchema,
  defineActionType,
  defineMcpTool,
} from '@openora/core/contracts';

export const OPEN_WITHDRAWALS_LIMIT = 20;

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
    "A player's balances, their completed deposits, withdrawals, bets and wins per currency " +
    'over the last windowDays days, and the withdrawals still awaiting a decision (pending or ' +
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
  payloadSchema: HoldWithdrawalPayloadSchema,
  errors: ['player_not_found', 'withdrawal_not_found', 'withdrawal_not_pending'],
});
