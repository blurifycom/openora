/**
 * Bonus lifecycle command port: a single named grant taken away by a system/job context that has
 * no admin session to assert - the shape `forfeitAllFor` (reached only from inside the bonus
 * module, off `rg.*`/`player.account.closed` events) cannot give an external caller, since that
 * sweeps every live grant a player holds rather than the one grant a rule decided on. Mirrors the
 * BONUS_GRANTS idiom: a command port, not a class export, so the bonus module's own transaction
 * and audit-row shape stay its own.
 */
import type { BonusForfeitReason } from '../schemas/promo.js';
import { createToken, type Token } from './token.js';

export type BonusForfeitOutcome =
  | { ok: true; grantId: string; userId: string; currency: string; forfeitedAmount: string }
  | { ok: false; reason: 'not_found' | 'not_forfeitable' };

export type BonusLifecycleCommands = {
  /**
   * Takes one grant away, by id, for a reason that names no admin - a job's own rule broke, not
   * an admin's decision or a responsible-gambling event (both already have their own path). The
   * grant's own status guard makes a retry (or a grant that already closed some other way)
   * resolve to `not_forfeitable` rather than a second ledger entry.
   */
  forfeit(grantId: string, reason: BonusForfeitReason, note: string): Promise<BonusForfeitOutcome>;
};

export const BONUS_LIFECYCLE: Token<BonusLifecycleCommands> = createToken('BONUS_LIFECYCLE');
