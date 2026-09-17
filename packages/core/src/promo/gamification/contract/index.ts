import * as z from 'zod';
import { TimestampSchema, UuidSchema } from '@openora/core/contracts';

export const GamificationSchema = z.object({
  id: UuidSchema,
  createdAt: TimestampSchema,
});

export type Gamification = z.infer<typeof GamificationSchema>;

export const gamificationContract = {};
