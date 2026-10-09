import * as z from 'zod';
import { PlayerSchema, TagKeySchema, UuidSchema, defineMcpTool } from '@openora/core/contracts';

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
