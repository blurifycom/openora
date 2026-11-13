import { DrizzleService, type DrizzleTx } from '@openora/core/server';
import { eq } from 'drizzle-orm';
import type { LoginEnforcementPort, User } from '@openora/core/contracts';
import { user } from '../schema/index.js';
import type { PlayEligibilityPublisher } from './play-eligibility.service.js';
import { SessionService } from './session.service.js';

// Identity-owned writer for the LOGIN_ENFORCEMENT port. `block` sets the RG columns
// and revokes every active session (the session-termination requirement); `unblock`
// clears them. Compliance drives this through the port - never the identity schema. Both push
// the result to the ledger's play eligibility; a block the ledger refuses does not commit.
export class LoginEnforcementService implements LoginEnforcementPort {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly sessions: SessionService,
    private readonly playEligibility: PlayEligibilityPublisher,
  ) {}

  async block(userId: User['id'], opts: { until: Date | null }): Promise<void> {
    await this.write(userId, { rgBlocked: true, rgBlockedUntil: opts.until });
    await this.sessions.revokeAllSessions(userId);
  }

  async unblock(userId: User['id']): Promise<void> {
    await this.write(userId, { rgBlocked: false, rgBlockedUntil: null });
  }

  private async write(
    userId: User['id'],
    set: { rgBlocked: boolean; rgBlockedUntil: Date | null },
  ): Promise<void> {
    const publication = await this.drizzle.db.transaction(async (tx: DrizzleTx) => {
      await tx.update(user).set(set).where(eq(user.id, userId));
      return this.playEligibility.publish(tx, userId);
    });
    await publication.afterCommit();
  }
}
