import * as z from 'zod';
import { GameSchema, GameRoundSchema } from '../contract/index.js';

export { GameSchema, GameRoundSchema };

export type Game = z.infer<typeof GameSchema>;
export type GameRound = z.infer<typeof GameRoundSchema>;
