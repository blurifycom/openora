import { oc } from '@orpc/contract';
import * as z from 'zod';
import { IdInputSchema } from '@oss/shared-schemas';

export const GameSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  category: z.string(),
  thumbnailUrl: z.string().nullable(),
  isActive: z.boolean(),
  metadata: z.unknown().nullable(),
});

export const GameRoundSchema = z.object({
  id: z.string(),
  gameId: z.string(),
  userId: z.string(),
  status: z.enum(['active', 'completed', 'cancelled']),
  betAmount: z.string(),
  winAmount: z.string(),
  currency: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
});

export const StartRoundInputSchema = z.object({
  gameId: z.string(),
  currency: z.string(),
});

export const StartRoundOutputSchema = z.object({
  roundId: z.string(),
  launchUrl: z.string(),
  token: z.string(),
});

export const EndRoundInputSchema = z.object({
  roundId: z.string(),
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
