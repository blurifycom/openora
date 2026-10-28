/**
 * Bonus lifecycle command port: grants taken away from outside the bonus module. `forfeit` closes
 * a single named grant for a system/job context that has no admin session to assert; `forfeitHeld`
 * closes every grant a player holds on the caller's own transaction, for a money movement whose
 * rule ends the bonus (a withdrawal). Mirrors the BONUS_GRANTS idiom: a command port, not a class
 * export, so the bonus module's own transaction and audit-row shape stay its own.
 */
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
  /**
   * Takes one grant away, by id, for a reason that names no admin - a job's own rule broke, not
   * an admin's decision or a responsible-gambling event (both already have their own path). The
   * grant's own status guard makes a retry (or a grant that already closed some other way)
   * resolve to `not_forfeitable` rather than a second ledger entry.
   */
  forfeit(grantId: string, reason: BonusForfeitReason, note: string): Promise<BonusForfeitOutcome>;
  /**
   * Every live grant the player held when the caller's transaction began, in every currency,
   * taken away on that transaction - so the forfeit commits or rolls back with the movement that
   * caused it. A grant another path closed first is skipped, never refused: the player made no
   * attempt on it. Emits nothing; the caller announces `promo.bonus.forfeited` after its commit.
   */
  forfeitHeld(tx: unknown, args: BonusForfeitHeldArgs): Promise<BonusForfeitedGrant[]>;
};

export const BONUS_LIFECYCLE: Token<BonusLifecycleCommands> = createToken('BONUS_LIFECYCLE');
