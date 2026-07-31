import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type {
  AdminPermissionResolver,
  RateLimiterAdapter,
  RateLimitKey,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { mock, makeEventBus, adminCaller } from '../../../testing/mock.js';
import { AdminGuard } from '../admin-guard.js';
import type { SessionResolver } from '../session-resolver.js';

let db: TestDb;

const requestContext = (headers: Record<string, string>) => ({ request: { headers } });

const ADMIN_HEADERS = { 'x-real-ip': '127.0.0.1', 'user-agent': 'Mozilla/5.0' };

function makeGuard({
  userId,
  grants,
  rateLimiter,
}: {
  userId?: string;
  grants?: { resource: string; action: string }[];
  rateLimiter?: RateLimiterAdapter<RateLimitKey>;
} = {}) {
  const events = makeEventBus();
  const sessions = mock<SessionResolver>({ resolveUserId: vi.fn(async () => userId) });
  const permissionResolver = grants
    ? mock<AdminPermissionResolver>({ getGrants: vi.fn(async () => grants) })
    : undefined;
  const guard = new AdminGuard(db.drizzle, sessions, permissionResolver, events, rateLimiter);
  return { guard, events };
}

function fakeStatefulRateLimiter(): RateLimiterAdapter<RateLimitKey> {
  const counts = new Map<string, number>();
  return mock<RateLimiterAdapter<RateLimitKey>>({
    consume: vi.fn(async (key: string, opts: { limit: number }) => {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      const allowed = count <= opts.limit;
      return { allowed, retryAfterMs: allowed ? 0 : 1000 };
    }),
    reset: vi.fn(async (key: string) => {
      counts.delete(key);
    }),
  });
}

async function seedUser(role: string) {
  const id = randomUUID();
  await db.drizzle.db.execute(sql`INSERT INTO "user" (id, role) VALUES (${id}, ${role})`);
  return id;
}

beforeAll(async () => {
  db = await createTestDb([
    async (databaseUrl) => {
      process.env['DATABASE_URL'] = databaseUrl;
    },
  ]);
  await db.drizzle.db.execute(sql`CREATE TABLE "user" (id uuid PRIMARY KEY, role text NOT NULL)`);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE "user"`);
});

describe('AdminGuard.assert - authentication (real PG)', () => {
  it('throws UNAUTHORIZED when the context carries no request', async () => {
    const { guard } = makeGuard();

    await expect(guard.assert({})).rejects.toThrow(
      expect.objectContaining({ code: 'UNAUTHORIZED' }),
    );
  });

  it('throws UNAUTHORIZED when no session resolves', async () => {
    const { guard, events } = makeGuard();

    await expect(guard.assert(requestContext(ADMIN_HEADERS))).rejects.toThrow(
      expect.objectContaining({ code: 'UNAUTHORIZED' }),
    );
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('throws FORBIDDEN and emits when the session points at a missing user row', async () => {
    const userId = randomUUID();
    const { guard, events } = makeGuard({ userId });

    await expect(guard.assert(requestContext(ADMIN_HEADERS))).rejects.toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.unauthorized_access',
      expect.objectContaining({ userId, resource: 'admin', action: 'access', role: undefined }),
    );
  });
});

describe('AdminGuard.assert - static role fallback (real PG)', () => {
  it('returns the caller for an admin with a granted permission', async () => {
    const userId = await seedUser('admin');
    const { guard, events } = makeGuard({ userId });

    const caller = await guard.assert(requestContext(ADMIN_HEADERS), 'admin', 'delete');

    expect(caller).toMatchObject({
      userId,
      role: 'admin',
      ip: '127.0.0.1',
      userAgent: 'Mozilla/5.0',
    });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('passes the coarse check for an admin with no resource requested', async () => {
    const userId = await seedUser('admin');
    const { guard } = makeGuard({ userId });

    await expect(guard.assert(requestContext(ADMIN_HEADERS))).resolves.toMatchObject({
      role: 'admin',
    });
  });

  it('denies a support role a permission its static role lacks', async () => {
    const userId = await seedUser('support');
    const { guard, events } = makeGuard({ userId });

    await expect(
      guard.assert(
        requestContext({ 'x-forwarded-for': '192.168.1.1, 10.0.0.1', 'user-agent': 'Mozilla/5.0' }),
        'admin',
        'delete',
      ),
    ).rejects.toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.unauthorized_access',
      expect.objectContaining({
        userId,
        resource: 'admin',
        action: 'delete',
        ip: '192.168.1.1',
        role: 'support',
      }),
    );
  });

  it('allows a support role the permissions it does hold', async () => {
    const userId = await seedUser('support');
    const { guard } = makeGuard({ userId });

    await expect(
      guard.assert(requestContext(ADMIN_HEADERS), 'player', 'view'),
    ).resolves.toMatchObject({ role: 'support' });
  });

  it('denies a role with no entry in the static table', async () => {
    const userId = await seedUser('player');
    const { guard, events } = makeGuard({ userId });

    await expect(guard.assert(requestContext(ADMIN_HEADERS), 'admin', 'delete')).rejects.toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.unauthorized_access',
      expect.objectContaining({ userId, role: 'player', action: 'delete' }),
    );
  });

  it('denies the coarse check for a non-admin role with the default admin:access pair', async () => {
    const userId = await seedUser('player');
    const { guard, events } = makeGuard({ userId });

    await expect(guard.assert(requestContext(ADMIN_HEADERS))).rejects.toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.unauthorized_access',
      expect.objectContaining({ resource: 'admin', action: 'access', role: 'player' }),
    );
  });
});

describe('AdminGuard.assert - DB grants (real PG)', () => {
  it('allows a permission the resolver grants', async () => {
    const userId = await seedUser('admin');
    const { guard } = makeGuard({ userId, grants: [{ resource: 'admin', action: 'delete' }] });

    await expect(
      guard.assert(requestContext(ADMIN_HEADERS), 'admin', 'delete'),
    ).resolves.toMatchObject({ userId });
  });

  it('denies and emits when the resolver returns no matching grant', async () => {
    const userId = await seedUser('admin');
    const { guard, events } = makeGuard({ userId, grants: [] });

    await expect(guard.assert(requestContext(ADMIN_HEADERS), 'admin', 'delete')).rejects.toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.unauthorized_access',
      expect.objectContaining({ userId, resource: 'admin', action: 'delete', role: 'admin' }),
    );
  });

  it('lets DB grants override what the static role would have allowed', async () => {
    const userId = await seedUser('admin');
    const { guard } = makeGuard({ userId, grants: [{ resource: 'player', action: 'view' }] });

    await expect(guard.assert(requestContext(ADMIN_HEADERS), 'admin', 'delete')).rejects.toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });
});

describe('AdminGuard.recordDeniedAccess', () => {
  it('emits and records when the caller genuinely lacks the level (static role fallback)', async () => {
    const { guard, events } = makeGuard();
    const caller = adminCaller({ role: 'support' });

    await expect(guard.recordDeniedAccess(caller, 'game', 'read')).resolves.toEqual({
      recorded: true,
    });
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.unauthorized_access',
      expect.objectContaining({
        userId: caller.userId,
        resource: 'game',
        action: 'view',
        role: 'support',
      }),
    );
  });

  it('is a no-op when the caller already holds the level (static role fallback) - anti-forgery', async () => {
    const { guard, events } = makeGuard();
    const caller = adminCaller({ role: 'admin' });

    await expect(guard.recordDeniedAccess(caller, 'game', 'read')).resolves.toEqual({
      recorded: false,
    });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('is a no-op when DB grants already cover the level - anti-forgery via the DB path', async () => {
    const { guard, events } = makeGuard({ grants: [{ resource: 'game', action: 'view' }] });
    const caller = adminCaller({ role: 'support' });

    await expect(guard.recordDeniedAccess(caller, 'game', 'read')).resolves.toEqual({
      recorded: false,
    });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('throws BAD_REQUEST for a resource with no entry in the permission statement', async () => {
    const { guard } = makeGuard();
    const caller = adminCaller();

    await expect(guard.recordDeniedAccess(caller, 'not-a-resource', 'read')).rejects.toThrow(
      expect.objectContaining({ code: 'BAD_REQUEST' }),
    );
  });

  it('throws BAD_REQUEST for level: no_access', async () => {
    const { guard } = makeGuard();
    const caller = adminCaller();

    await expect(guard.recordDeniedAccess(caller, 'game', 'no_access')).rejects.toThrow(
      expect.objectContaining({ code: 'BAD_REQUEST' }),
    );
  });

  it('reports the actually-missing action, not just the first action for the level - partial grant', async () => {
    const { guard, events } = makeGuard({ grants: [{ resource: 'game', action: 'view' }] });
    const caller = adminCaller({ role: 'support' });

    await expect(guard.recordDeniedAccess(caller, 'game', 'read_write')).resolves.toEqual({
      recorded: true,
    });
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.unauthorized_access',
      expect.objectContaining({ resource: 'game', action: 'enable' }),
    );
    expect(events.emit).not.toHaveBeenCalledWith(
      'identity.user.unauthorized_access',
      expect.objectContaining({ action: 'view' }),
    );
  });

  it('falls back to the full action set for a view-less resource + read (content)', async () => {
    const { guard, events } = makeGuard();
    const caller = adminCaller({ role: 'support' });

    await expect(guard.recordDeniedAccess(caller, 'content', 'read')).resolves.toEqual({
      recorded: true,
    });
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.unauthorized_access',
      expect.objectContaining({ resource: 'content' }),
    );
  });

  it('re-checks against FRESH grants, not a stale cached getGrants - anti-forgery under a TOCTOU race', async () => {
    const getGrants = vi.fn(async () => []);
    const getFreshGrants = vi.fn(async () => [{ resource: 'game', action: 'view' }]);
    const permissionResolver = mock<AdminPermissionResolver>({ getGrants, getFreshGrants });
    const events = makeEventBus();
    const sessions = mock<SessionResolver>({ resolveUserId: vi.fn(async () => undefined) });
    const guard = new AdminGuard(db.drizzle, sessions, permissionResolver, events);
    const caller = adminCaller({ role: 'support' });

    await expect(guard.recordDeniedAccess(caller, 'game', 'read')).resolves.toEqual({
      recorded: false,
    });
    expect(getFreshGrants).toHaveBeenCalledWith(caller.userId);
    expect(getGrants).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('throttles repeated denials for the same (user, resource, level) within the window', async () => {
    const rateLimiter = fakeStatefulRateLimiter();
    const { guard, events } = makeGuard({ rateLimiter });
    const caller = adminCaller({ role: 'support' });

    await expect(guard.recordDeniedAccess(caller, 'game', 'read')).resolves.toEqual({
      recorded: true,
    });
    await expect(guard.recordDeniedAccess(caller, 'game', 'read')).resolves.toEqual({
      recorded: false,
    });
    await expect(guard.recordDeniedAccess(caller, 'game', 'read')).resolves.toEqual({
      recorded: false,
    });
    expect(events.emit).toHaveBeenCalledTimes(1);
  });

  it('does not throttle across different resources for the same user', async () => {
    const rateLimiter = fakeStatefulRateLimiter();
    const { guard, events } = makeGuard({ rateLimiter });
    const caller = adminCaller({ role: 'support' });

    await guard.recordDeniedAccess(caller, 'game', 'read');
    await guard.recordDeniedAccess(caller, 'game-config', 'read');

    expect(events.emit).toHaveBeenCalledTimes(2);
  });
});
