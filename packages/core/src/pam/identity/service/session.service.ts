import { ORPCError } from '@orpc/server';
import { type EventBus } from '@blurifycom/core/server';
import { DrizzleService } from '@blurifycom/core/server';
import { eq, desc, and, gt } from 'drizzle-orm';
import { session } from '../schema/index.js';

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export type SessionItem = {
  id: string;
  token: string;
  expiresAt: string;
  createdAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type SessionServiceDeps = {
  drizzle: DrizzleService;
  events: EventBus;
};

export class SessionService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;

  constructor({ drizzle, events }: SessionServiceDeps) {
    this.drizzle = drizzle;
    this.events = events;
  }

  async listSessions(playerId: string) {
    const rows = await this.drizzle.db
      .select()
      .from(session)
      .where(eq(session.userId, playerId))
      .orderBy(desc(session.createdAt));

    const sessions: SessionItem[] = rows.map((s) => ({
      id: s.id,
      token: s.token,
      expiresAt: toIso(s.expiresAt),
      createdAt: toIso(s.createdAt),
      ipAddress: s.ipAddress,
      userAgent: s.userAgent,
    }));

    return { sessions };
  }

  async revokeSession(playerId: string, token: string) {
    const now = new Date();
    const updated = await this.drizzle.db
      .update(session)
      .set({ expiresAt: now })
      .where(and(eq(session.token, token), eq(session.userId, playerId)))
      .returning({ id: session.id });

    if (updated.length === 0) {
      throw new ORPCError('NOT_FOUND', { message: 'Session not found' });
    }

    this.events.emit('identity.session.revoked', { userId: playerId, sessionToken: token });
    return { success: true as const };
  }

  async revokeAllSessions(playerId: string) {
    const now = new Date();
    await this.drizzle.db
      .update(session)
      .set({ expiresAt: now })
      .where(and(eq(session.userId, playerId), gt(session.expiresAt, now)));

    this.events.emit('identity.sessions.revoked_all', { userId: playerId });
    return { success: true as const };
  }
}
