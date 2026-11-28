import { createToken, type Token } from './token.js';
import type { DomainEventPayload } from '../schemas/events.js';

export type SocialCommands = {
  dissolveFriendshipOnBlock(
    tx: unknown,
    blockerId: string,
    blockedId: string,
    blockerPlayerId: string | null,
  ): Promise<FriendshipDissolvedPayload | null>;
};

export type FriendshipDissolvedPayload = DomainEventPayload<'social.friendship.removed'>;

export const SOCIAL_COMMANDS: Token<SocialCommands> = createToken('SOCIAL_COMMANDS');
