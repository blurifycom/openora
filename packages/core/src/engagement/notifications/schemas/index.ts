import * as z from 'zod';
import { UuidSchema } from '@blurifycom/core/contracts';

export const CreateNotificationInputSchema = z.object({
  userId: UuidSchema,
  type: z.string(),
  title: z.string(),
  body: z.string(),
});

export type CreateNotificationInput = z.infer<typeof CreateNotificationInputSchema>;
