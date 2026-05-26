import * as z from 'zod';
import { GameSchema, GameRoundSchema } from '@oss/orpc-contract/gaming';

export { GameSchema, GameRoundSchema };

export type Game = z.infer<typeof GameSchema>;
export type GameRound = z.infer<typeof GameRoundSchema>;
