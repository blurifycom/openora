import * as z from 'zod';
import {
  CurrencyTickerSchema,
  FIND_TOOL_MAX_LIMIT,
  FindToolLimitSchema,
  KYC_STATUSES,
  KycStatusSchema,
  MoneyAmountSchema,
  MoneyThresholdSchema,
  PLAYER_STATUSES,
  PlayerSchema,
  PlayerStatusSchema,
  TagKeySchema,
  TimestampSchema,
  UuidSchema,
  checkDayBounds,
  defineMcpTool,
  tagKeys,
} from '@openora/core/contracts';

export const PlayerSummaryToolOutputSchema = z.object({
  playerId: UuidSchema,
  ...PlayerSchema.omit({ id: true }).shape,
  tags: z.array(TagKeySchema),
});

export const playerSummaryTool = defineMcpTool({
  id: 'player.summary',
  title: 'Player summary',
  description:
    "Returns one player's account record: username, email, name, date of birth, phone, country, " +
    'currency, status, KYC status, level, lifetime wagered and deposited totals, last-seen time, ' +
    'timezone and active tags. Use it to look a player up by player id before judging or ' +
    'proposing anything about them.',
  class: 'read',
  schemaVersion: 1,
  iam: { resource: 'player', action: 'view' },
  inputSchema: z.object({ playerId: UuidSchema }),
  outputSchema: PlayerSummaryToolOutputSchema,
  redact: {
    allow: [
      'playerId',
      'userId',
      'username',
      'email',
      'firstName',
      'lastName',
      'dateOfBirth',
      'phone',
      'country',
      'currency',
      'status',
      'kycStatus',
      'level',
      'totalWagered',
      'totalDeposits',
      'lastSeenAt',
      'timezone',
      'timezoneUpdatedAt',
      'createdAt',
      'updatedAt',
      'tags',
    ],
    personal: [
      'userId',
      'username',
      'email',
      'firstName',
      'lastName',
      'dateOfBirth',
      'phone',
      'timezone',
      'timezoneUpdatedAt',
    ],
  },
  errors: ['player_not_found'],
});

/** At most this many tags players.find requires a player to hold at once. */
export const PLAYERS_FIND_MAX_TAGS = 10;

export const PLAYERS_FIND_SORT_FIELDS = [
  'registeredAt',
  'lastSeenAt',
  'totalDeposits',
  'totalWagered',
] as const;
export const PlayersFindSortBySchema = z.enum(PLAYERS_FIND_SORT_FIELDS);
export type PlayersFindSortBy = z.infer<typeof PlayersFindSortBySchema>;

export const PlayersFindInputSchema = z
  .object({
    status: z.array(PlayerStatusSchema).max(PLAYER_STATUSES.length).optional(),
    kycStatus: z.array(KycStatusSchema).max(KYC_STATUSES.length).optional(),
    country: z
      .string()
      .regex(/^[A-Za-z]{2}$/, 'ISO 3166-1 alpha-2 code, e.g. DE')
      .max(2)
      .optional(),
    currency: CurrencyTickerSchema.max(10).optional(),
    tagKeys: z.array(TagKeySchema).max(PLAYERS_FIND_MAX_TAGS).optional(),
    registeredFrom: z.iso.date().optional(),
    registeredTo: z.iso.date().optional(),
    lastSeenFrom: z.iso.date().optional(),
    lastSeenTo: z.iso.date().optional(),
    minTotalDeposits: MoneyThresholdSchema.optional(),
    sortBy: PlayersFindSortBySchema.default('registeredAt'),
    sortDir: z.enum(['desc', 'asc']).default('desc'),
    limit: FindToolLimitSchema,
  })
  .superRefine((input, ctx) => {
    checkDayBounds(
      input.registeredFrom,
      input.registeredTo,
      { from: 'registeredFrom', to: 'registeredTo' },
      ctx,
    );
    checkDayBounds(
      input.lastSeenFrom,
      input.lastSeenTo,
      { from: 'lastSeenFrom', to: 'lastSeenTo' },
      ctx,
    );
  });
export type PlayersFindInput = z.infer<typeof PlayersFindInputSchema>;

export const PlayersFindOutputSchema = z.object({
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
  players: z
    .array(
      z.object({
        playerId: UuidSchema,
        status: PlayerStatusSchema,
        kycStatus: KycStatusSchema,
        country: z.string().nullable(),
        currency: CurrencyTickerSchema,
        level: z.number().int(),
        registeredAt: TimestampSchema,
        lastSeenAt: TimestampSchema.nullable(),
        totalDeposits: MoneyAmountSchema,
        totalWagered: MoneyAmountSchema,
        tagKeys: z.array(TagKeySchema).max(tagKeys.length),
      }),
    )
    .max(FIND_TOOL_MAX_LIMIT),
});
export type PlayersFind = z.infer<typeof PlayersFindOutputSchema>;

export const playersFindTool = defineMcpTool({
  id: 'players.find',
  title: 'Find players',
  description:
    'Lists the players matching every filter given, each by playerId with status, KYC status, ' +
    'country, currency, level, registration and last-seen time, lifetime deposits and wagered, ' +
    'and active tag keys. Filters: status and kycStatus (any of those listed), country (ISO ' +
    '3166-1 alpha-2), currency, tagKeys (at most 10, the player holds every one; vip is the VIP ' +
    'tag), registeredFrom/registeredTo and lastSeenFrom/lastSeenTo (whole UTC days, either end ' +
    'optional), minTotalDeposits. Lifetime totals are decimal strings in the player currency, so ' +
    'narrow by currency to compare them. sortBy registeredAt (default), lastSeenAt, totalDeposits ' +
    'or totalWagered, sortDir desc (default) or asc; a player never seen sorts last. Lists at ' +
    'most limit players (1 to 50, default 20); total counts every match and truncated is true ' +
    'when more matched. No name, email, username, phone, birth date or address is returned: use ' +
    'player.summary for one player.',
  class: 'read',
  schemaVersion: 1,
  iam: { resource: 'player', action: 'view' },
  inputSchema: PlayersFindInputSchema,
  outputSchema: PlayersFindOutputSchema,
  redact: { allow: ['total', 'truncated', 'players'] },
  errors: [],
});
