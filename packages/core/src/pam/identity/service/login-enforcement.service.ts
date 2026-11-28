import type { DrizzleTx } from '@openora/core/server';
import { eq } from 'drizzle-orm';
import type { LoginEnforcementPort, User } from '@openora/core/contracts';
import { user } from '../schema/index.js';
import type { PlayEligibilityPublisher } from './play-eligibility.service.js';
import type { SessionService } from './session.service.js';

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
