import * as z from 'zod';

export const GAME_TYPES = ['original', 'casino', 'sportsbook'] as const;
export const GameTypeSchema = z.enum(GAME_TYPES);
export type GameType = z.infer<typeof GameTypeSchema>;
