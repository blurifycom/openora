import * as z from 'zod';
import { CountryCodeSchema, UuidSchema } from '../schemas/index.js';
import { createToken, type Token } from './token.js';

export const GAME_GEO_DENIAL_REASONS = [
  'global_block',
  'provider_block',
  'game_block',
  'geo_unresolved',
  'game_not_found',
] as const;

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
  /** Sorted, deduped country codes blocked platform-wide (config + a global block rule). */
  listGloballyBlockedCountries(): Promise<string[]>;
  /**
   * Every game and provider geo rule, each `(id, country)` pair once, narrowed by `filter`: only
   * those of `countries`, of `gameIds` and written by `source` when given. A provider rule has no
   * game and no source, so `gameIds` and `source` narrow `games` only and `providers` is narrowed
   * by `countries` alone; a caller that needs one game's provider rules filters them by its
   * provider. The admin catalog filters read these instead of compliance's tables. Optional so an
   * operator's own implementation keeps compiling; without it those filters are refused.
   */
  listGeoRulePairs?(filter?: {
    countries?: readonly string[];
    gameIds?: readonly string[];
    source?: string;
  }): Promise<GameGeoRules>;
};

export type GameGeoRules = {
  games: { gameId: string; countryCode: string; source: string }[];
  providers: { providerId: string; countryCode: string }[];
};

export const GAME_GEO_CHECK: Token<GameGeoCheckPort> =
  createToken<GameGeoCheckPort>('GAME_GEO_CHECK');
