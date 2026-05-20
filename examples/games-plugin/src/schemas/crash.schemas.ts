import * as z from 'zod';

// Input schemas

export const CrashBetInputSchema = z.object({
  roundId: z.string(),
  betAmount: z.number().positive(),
});

export const CrashCashOutInputSchema = z.object({
  betId: z.string(),
});

// Output schemas

export const CrashRoundSchema = z.object({
  id: z.string(),
  multiplier: z.number(),
  status: z.enum(['active', 'crashed']),
  createdAt: z.string().datetime(),
});

export const CrashBetSchema = z.object({
  id: z.string(),
  roundId: z.string(),
  userId: z.string(),
  betAmount: z.number(),
  cashOutAt: z.number().nullable(),
  winAmount: z.number(),
  createdAt: z.string().datetime(),
});

// Inferred types

export type CrashBetInput = z.infer<typeof CrashBetInputSchema>;
export type CrashCashOutInput = z.infer<typeof CrashCashOutInputSchema>;
export type CrashRound = z.infer<typeof CrashRoundSchema>;
export type CrashBet = z.infer<typeof CrashBetSchema>;
