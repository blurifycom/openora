import * as z from 'zod';

export const CreateNotificationInputSchema = z.object({
  userId: z.uuid(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
});

export type CreateNotificationInput = z.infer<typeof CreateNotificationInputSchema>;
