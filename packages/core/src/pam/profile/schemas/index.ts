import { PlayerSchema, PlayerStatusSchema, KycStatusSchema } from '@oss/core/contracts';
import { UpdatePlayerProfileInputSchema } from '../contract/index.js';
import type { z } from 'zod';

export { PlayerSchema, PlayerStatusSchema, KycStatusSchema, UpdatePlayerProfileInputSchema };

export type Player = z.infer<typeof PlayerSchema>;
export type PlayerStatus = z.infer<typeof PlayerStatusSchema>;
export type KycStatus = z.infer<typeof KycStatusSchema>;
export type UpdatePlayerProfileInput = z.infer<typeof UpdatePlayerProfileInputSchema>;
