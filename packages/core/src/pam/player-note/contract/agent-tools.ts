import z from 'zod';
import { UuidSchema, defineActionType } from '@openora/core/contracts';
import { PLAYER_NOTE_CONTENT_MAX_LENGTH } from './player-note-content.js';

export const addNoteAction = defineActionType({
  id: 'add_note',
  title: 'Add a player note',
  description:
    "Adds an internal note to a player's account that only admins can read. Use it to record a " +
    'finding or the reason behind another action; a note cannot be edited or deleted once added.',
  schemaVersion: 1,
  iam: { resource: 'player-note', action: 'create' },
  reversible: false,
  payloadSchema: z.object({
    playerId: UuidSchema,
    content: z.string().trim().min(1).max(PLAYER_NOTE_CONTENT_MAX_LENGTH),
  }),
  errors: ['player_not_found'],
});
