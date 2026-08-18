/**
 * Social command port: chat's blockUser() dissolves any active friendship on the
 * caller's own tx, so the dissolve is atomic with the block. ADR-0017.
 */
import { createToken, type Token } from './token.js';

export type SocialCommands = {
  dissolveFriendshipOnBlock(tx: unknown, blockerId: string, blockedId: string): Promise<void>;
};

export const SOCIAL_COMMANDS: Token<SocialCommands> = createToken('SOCIAL_COMMANDS');
