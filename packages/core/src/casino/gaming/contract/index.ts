import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  CurrencyCodeSchema,
  GameTypeSchema,
  IdInputSchema,
  MoneyAmountSchema,
  UuidSchema,
} from '@openora/core/contracts';

export { GameTypeSchema } from '@openora/core/contracts';

export const GAME_ROUND_STATUSES = ['active', 'completed', 'cancelled'] as const;
export const GameRoundStatusSchema = z.enum(GAME_ROUND_STATUSES);
export type GameRoundStatus = z.infer<typeof GameRoundStatusSchema>;

export const GameSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  provider: z.string(),
  category: z.string(),
  gameType: GameTypeSchema,
  thumbnailUrl: z.string().nullable(),
  isActive: z.boolean(),
  metadata: z.unknown().nullable(),
});

export const GameRoundSchema = z.object({
  id: UuidSchema,
  gameId: UuidSchema,
  userId: UuidSchema,
  status: GameRoundStatusSchema,
  betAmount: MoneyAmountSchema,
  winAmount: MoneyAmountSchema,
  currency: CurrencyCodeSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
});
export type GameRound = z.infer<typeof GameRoundSchema>;

export const PositiveMoneyAmountSchema = MoneyAmountSchema.refine((v) => Number(v) > 0, {
  message: 'must be greater than zero',
});

export const StartRoundInputSchema = z.object({
  gameId: UuidSchema,
  currency: CurrencyCodeSchema,
  betAmount: PositiveMoneyAmountSchema,
});

export const StartRoundOutputSchema = z.object({
  roundId: UuidSchema,
  launchUrl: z.string(),
  token: z.string(),
});

export const EndRoundInputSchema = z.object({
  roundId: UuidSchema,
});

export const EndRoundOutputSchema = z.object({
  success: z.literal(true),
  outcome: z.unknown().optional(),
});

export const gamingContract = {
  listGames: oc.route({ method: 'GET', path: '/gaming/games' }).output(z.array(GameSchema)),

  getGame: oc
    .route({ method: 'GET', path: '/gaming/games/{id}' })
    .input(IdInputSchema)
    .output(GameSchema),

  startRound: oc
    .route({ method: 'POST', path: '/gaming/rounds/start' })
    .input(StartRoundInputSchema)
    .output(StartRoundOutputSchema),

  endRound: oc
    .route({ method: 'POST', path: '/gaming/rounds/{roundId}/end' })
    .input(EndRoundInputSchema)
    .output(EndRoundOutputSchema),

  listRounds: oc.route({ method: 'GET', path: '/gaming/rounds' }).output(z.array(GameRoundSchema)),
};
