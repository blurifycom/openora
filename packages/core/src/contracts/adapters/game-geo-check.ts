import * as z from 'zod';
import { CountryCodeSchema, UuidSchema } from '../schemas/index.js';
import { createToken, type Token } from './token.js';

export const GAME_GEO_DENIAL_REASONS = ['global_block', 'game_block', 'geo_unresolved'] as const;

export const GameGeoDenialReasonSchema = z.enum(GAME_GEO_DENIAL_REASONS);
export type GameGeoDenialReason = z.infer<typeof GameGeoDenialReasonSchema>;

export const GameGeoCheckInputSchema = z.object({
  gameId: UuidSchema,
  ipAddress: z.string().nullable(),
});
export type GameGeoCheckInput = z.infer<typeof GameGeoCheckInputSchema>;

export const GameGeoDecisionSchema = z.discriminatedUnion('allowed', [
  z.object({
    allowed: z.literal(true),
    countryCode: CountryCodeSchema.nullable(),
    reason: z.null(),
  }),
  z.object({
    allowed: z.literal(false),
    countryCode: CountryCodeSchema.nullable(),
    reason: GameGeoDenialReasonSchema,
  }),
]);
export type GameGeoDecision = z.infer<typeof GameGeoDecisionSchema>;

export type GameGeoCheckPort = {
  checkGame(input: GameGeoCheckInput): Promise<GameGeoDecision>;
};

export const GAME_GEO_CHECK: Token<GameGeoCheckPort> =
  createToken<GameGeoCheckPort>('GAME_GEO_CHECK');
