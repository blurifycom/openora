import { oc } from '@orpc/contract';
import { UuidSchema, TimestampSchema } from '@blurifycom/core/contracts';
import z from 'zod';

export const PlayerNoteSchema = z.object({
  id: z.uuid(),
  playerId: z.uuid(),
  actorId: z.uuid(),
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
    .input(z.object({ playerId: UuidSchema }))
    .output(z.object({ notes: z.array(PlayerNoteSchema) })),

  create: oc
    .route({ method: 'POST', path: '/player/{playerId}/note' })
    .input(CreatePlayerNoteInputSchema)
    .output(PlayerNoteSchema),
};
