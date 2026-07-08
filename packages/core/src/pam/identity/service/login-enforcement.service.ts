import { DrizzleService } from '@openora/core/server';
import { eq } from 'drizzle-orm';
import type { LoginEnforcementPort } from '@openora/core/contracts';
import { user } from '../schema/index.js';
import { SessionService } from './session.service.js';

// Identity-owned writer for the LOGIN_ENFORCEMENT port. `block` sets the RG columns
// and revokes every active session (the session-termination requirement); `unblock`
// clears them. Compliance drives this through the port - never the identity schema.
export class LoginEnforcementService implements LoginEnforcementPort {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly sessions: SessionService,
  ) {}

  async block(userId: string, opts: { until: Date | null }): Promise<void> {
    await this.drizzle.db
      .update(user)
      .set({ rgBlocked: true, rgBlockedUntil: opts.until })
      .where(eq(user.id, userId));
    await this.sessions.revokeAllSessions(userId);
  }

  async unblock(userId: string): Promise<void> {
    await this.drizzle.db
      .update(user)
      .set({ rgBlocked: false, rgBlockedUntil: null })
      .where(eq(user.id, userId));
  }
}
