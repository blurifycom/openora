// Canonical game-type enum. Kept in the isomorphic contracts zone (not the gaming
// module's local contract/) because it is consumed cross-domain: the ADMIN_GAME_REPORTING
// port (contracts/adapters, isomorphic - can never import a domain) and admin-console's
// contract both need it, same reasoning as WALLET_TRANSACTION_TYPES in wallet-tx.ts. The
// casino/gaming module re-derives its `game` pgEnum from this same tuple so the DB enum,
// this contract, and every consumer share one source of truth.
import * as z from 'zod';

export const GAME_TYPES = ['original', 'casino', 'sportsbook'] as const;
export const GameTypeSchema = z.enum(GAME_TYPES);
export type GameType = z.infer<typeof GameTypeSchema>;
