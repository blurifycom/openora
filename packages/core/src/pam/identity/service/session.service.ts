import { ORPCError } from '@orpc/server';
import { createAuth } from '@blurifycom/core/server';
import { type EventBus, type NodeHeaders } from '@blurifycom/core/server';
import { DrizzleService } from '@blurifycom/core/server';
import { eq, desc } from 'drizzle-orm';
import { user, session, account, verification, twoFactor } from '../schema/index.js';

function nodeHeadersToHeaders(nodeHeaders: NodeHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

async function ensureOk(res: globalThis.Response): Promise<void> {
  if (res.ok) return;
  let message = `Request failed (${res.status})`;
  try {
    const parsed = JSON.parse(await res.text()) as { message?: string };
    if (parsed.message) message = parsed.message;
  } catch {
    // non-JSON body - keep the default message
  }
  throw new ORPCError(res.status === 401 ? 'UNAUTHORIZED' : 'BAD_REQUEST', { message });
}

// Narrow type cast for the three better-auth session endpoints we call. No `any`.
type SessionAuthApi = {
  listSessions: (opts: { headers: Headers; asResponse: true }) => Promise<globalThis.Response>;
  revokeSession: (opts: {
    body: { token: string };
    headers: Headers;
    asResponse: true;
  }) => Promise<globalThis.Response>;
  revokeSessions: (opts: { headers: Headers; asResponse: true }) => Promise<globalThis.Response>;
};

export type SessionItem = {
  id: string;
  token: string;
  expiresAt: string;
  createdAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  isCurrent: boolean;
};

export type SessionServiceDeps = {
  drizzle: DrizzleService;
  events: EventBus;
};

export class SessionService {
  private readonly auth: ReturnType<typeof createAuth>;
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;

  constructor({ drizzle, events }: SessionServiceDeps) {
    this.drizzle = drizzle;
    this.events = events;
    this.auth = createAuth({
      db: drizzle.db,
      schema: { user, session, account, verification, twoFactor },
    });
  }

  private get api() {
    return this.auth.api as unknown as SessionAuthApi;
  }

  async listSessions(reqHeaders: NodeHeaders) {
    const headers = nodeHeadersToHeaders(reqHeaders);

    const currentSession = await this.auth.api.getSession({ headers });
    if (!currentSession) throw new ORPCError('UNAUTHORIZED');

    const currentToken = currentSession.session.token;
    const userId = currentSession.user.id;

    const rows = await this.drizzle.db
      .select()
      .from(session)
      .where(eq(session.userId, userId))
      .orderBy(desc(session.createdAt));

    const sessions: SessionItem[] = rows.map((s) => ({
      id: s.id,
      token: s.token,
      expiresAt: toIso(s.expiresAt),
      createdAt: toIso(s.createdAt),
      ipAddress: s.ipAddress,
      userAgent: s.userAgent,
      isCurrent: s.token === currentToken,
    }));

    return { sessions };
  }

  async revokeSession(token: string, reqHeaders: NodeHeaders) {
    const headers = nodeHeadersToHeaders(reqHeaders);

    const currentSession = await this.auth.api.getSession({ headers });
    const userId = currentSession?.user?.id;
    if (!userId) throw new ORPCError('UNAUTHORIZED');

    const res = await this.api.revokeSession({ body: { token }, headers, asResponse: true });
    await ensureOk(res);

    this.events.emit('identity.session.revoked', { userId, sessionToken: token });
    return { success: true as const };
  }

  async revokeAllSessions(reqHeaders: NodeHeaders) {
    const headers = nodeHeadersToHeaders(reqHeaders);

    const currentSession = await this.auth.api.getSession({ headers });
    const userId = currentSession?.user?.id;
    if (!userId) throw new ORPCError('UNAUTHORIZED');

    const res = await this.api.revokeSessions({ headers, asResponse: true });
    await ensureOk(res);

    this.events.emit('identity.sessions.revoked_all', { userId });
    return { success: true as const };
  }
}
