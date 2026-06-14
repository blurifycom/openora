import {
  PlayerSchema,
  PlayerStatusSchema,
  KycStatusSchema,
  UpdatePlayerProfileInputSchema,
} from '@oss/orpc-contract';
import type { z } from 'zod';

export { PlayerSchema, PlayerStatusSchema, KycStatusSchema, UpdatePlayerProfileInputSchema };

export type Player = z.infer<typeof PlayerSchema>;
export type PlayerStatus = z.infer<typeof PlayerStatusSchema>;
export type KycStatus = z.infer<typeof KycStatusSchema>;
export type UpdatePlayerProfileInput = z.infer<typeof UpdatePlayerProfileInputSchema>;
