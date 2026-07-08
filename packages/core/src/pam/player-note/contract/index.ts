import { oc } from '@orpc/contract';
import { UuidSchema, TimestampSchema } from '@openora/core/contracts';
import { PageQuerySchema, paginated } from '@openora/core/contracts/kit';
import z from 'zod';

export const PlayerNoteSchema = z.object({
  id: UuidSchema,
  playerId: UuidSchema,
  actorId: UuidSchema,
  content: z.string(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const CreatePlayerNoteInputSchema = z.object({
  playerId: UuidSchema,
  content: z.string().min(1).max(5000),
});

export type PlayerNoteItem = z.infer<typeof PlayerNoteSchema>;
export type CreatePlayerNoteInput = z.infer<typeof CreatePlayerNoteInputSchema>;

export const playerNoteContract = {
  list: oc
    .route({ method: 'GET', path: '/player/{playerId}/note' })
    .input(PageQuerySchema.extend({ playerId: UuidSchema }))
    .output(paginated(PlayerNoteSchema)),

  create: oc
    .route({ method: 'POST', path: '/player/{playerId}/note' })
    .input(CreatePlayerNoteInputSchema)
    .output(PlayerNoteSchema),
};
