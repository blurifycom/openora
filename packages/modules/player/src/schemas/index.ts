import {
  PlayerSchema,
  PlayerStatusSchema,
  KycStatusSchema,
  PlayerRegistrationPointSchema,
  PlayerSummarySchema,
} from '@oss/orpc-contract/player';
import type { z } from 'zod';

export {
  PlayerSchema,
  PlayerStatusSchema,
  KycStatusSchema,
  PlayerRegistrationPointSchema,
  PlayerSummarySchema,
};

export type Player = z.infer<typeof PlayerSchema>;
export type PlayerStatus = z.infer<typeof PlayerStatusSchema>;
export type KycStatus = z.infer<typeof KycStatusSchema>;
export type PlayerRegistrationPoint = z.infer<typeof PlayerRegistrationPointSchema>;
export type PlayerSummary = z.infer<typeof PlayerSummarySchema>;
