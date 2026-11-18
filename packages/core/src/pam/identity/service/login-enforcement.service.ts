import type { DrizzleTx } from '@openora/core/server';
import { eq } from 'drizzle-orm';
import type { LoginEnforcementPort, User } from '@openora/core/contracts';
import { user } from '../schema/index.js';
import type { PlayEligibilityPublisher } from './play-eligibility.service.js';
import type { SessionService } from './session.service.js';

// Identity-owned writer for the LOGIN_ENFORCEMENT port. `block` sets the RG columns
// and revokes every active session (the session-termination requirement); `unblock`
// clears them. Compliance drives this through the port - never the identity schema. Both run on
// the caller's transaction and write the ledger's play eligibility there, so the block, the
// ledger row and the RG record that caused them commit or roll back together.
export class LoginEnforcementService implements LoginEnforcementPort {
  constructor(
    private readonly sessions: SessionService,
    private readonly playEligibility: PlayEligibilityPublisher,
  ) {}

  async block(userId: User['id'], opts: { until: Date | null }, tx: unknown): Promise<void> {
    await this.write(tx as DrizzleTx, userId, { rgBlocked: true, rgBlockedUntil: opts.until });
    await this.sessions.revokeAllSessionsIn(tx as DrizzleTx, userId);
  }

  async unblock(userId: User['id'], tx: unknown): Promise<void> {
    await this.write(tx as DrizzleTx, userId, { rgBlocked: false, rgBlockedUntil: null });
  }

  private async write(
    tx: DrizzleTx,
    userId: User['id'],
    set: { rgBlocked: boolean; rgBlockedUntil: Date | null },
  ): Promise<void> {
    await tx.update(user).set(set).where(eq(user.id, userId));
    await this.playEligibility.publish(tx, userId);
  }
}
