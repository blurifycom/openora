import type { ClientMeta } from '../schemas/common.js';
import type { DomainEventPayload } from '../schemas/events.js';
import type { BonusForfeitReason } from '../schemas/promo.js';
import { createToken, type Token } from './token.js';

type ForfeitedEvent = DomainEventPayload<'promo.bonus.forfeited'>;

export type BonusForfeitedGrant = Pick<
  ForfeitedEvent,
  'grantId' | 'userId' | 'currency' | 'forfeitedAmount'
>;

export type BonusForfeitOutcome =
  | ({ ok: true } & BonusForfeitedGrant)
  | { ok: false; reason: 'not_found' | 'not_forfeitable' };

export type BonusForfeitHeldArgs = Pick<ForfeitedEvent, 'userId' | 'reason'> & {
  actor: { id: ForfeitedEvent['userId']; isAdmin: boolean };
  note: string;
  meta?: ClientMeta | undefined;
};

export type BonusLifecycleCommands = {
  forfeit(grantId: string, reason: BonusForfeitReason, note: string): Promise<BonusForfeitOutcome>;
  forfeitHeld(tx: unknown, args: BonusForfeitHeldArgs): Promise<BonusForfeitedGrant[]>;
};

export const BONUS_LIFECYCLE: Token<BonusLifecycleCommands> = createToken('BONUS_LIFECYCLE');
