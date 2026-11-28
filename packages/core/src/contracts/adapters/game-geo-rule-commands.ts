import * as z from 'zod';
import {
  CountryCodeSchema,
  GEO_RULE_ADMIN_SOURCE,
  GeoRuleSourceSchema,
  BoundedReasonSchema,
  UuidSchema,
} from '../schemas/index.js';
import { createToken, type Token } from './token.js';

export const ReplaceGameGeoRulesInputSchema = z.object({
  source: GeoRuleSourceSchema.refine((source) => source !== GEO_RULE_ADMIN_SOURCE, {
    message: `"${GEO_RULE_ADMIN_SOURCE}" is reserved for backoffice rules`,
  }),
  reason: BoundedReasonSchema,
  rules: z
    .array(
      z.object({
        gameId: UuidSchema.transform((id) => id.toLowerCase()),
        countryCodes: z.array(CountryCodeSchema).max(250),
      }),
    )
    .refine((rules) => new Set(rules.map((rule) => rule.gameId)).size === rules.length, {
      message: 'Each game may appear once',
    }),
});
export type ReplaceGameGeoRulesInput = z.input<typeof ReplaceGameGeoRulesInputSchema>;

export type ReplaceGameGeoRulesResult = {
  inserted: number;
  deleted: number;
  notFoundGameIds: string[];
};

export type GameGeoRuleCommands = {
  replaceGameGeoRules(input: ReplaceGameGeoRulesInput): Promise<ReplaceGameGeoRulesResult>;
};

export const GAME_GEO_RULE_COMMANDS: Token<GameGeoRuleCommands> =
  createToken<GameGeoRuleCommands>('GAME_GEO_RULE_COMMANDS');
