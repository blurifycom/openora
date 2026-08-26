import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { AdminPermissionResolver } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { mock, makeEventBus } from '../../../testing/mock.js';
import { AdminGuard } from '../admin-guard.js';
import type { SessionResolver } from '../session-resolver.js';

let db: TestDb;

const requestContext = (headers: Record<string, string>) => ({ request: { headers } });

const ADMIN_HEADERS = { 'x-real-ip': '127.0.0.1', 'user-agent': 'Mozilla/5.0' };

function makeGuard({
  userId,
  grants,
  superAdmin,
}: {
  userId?: string;
  grants?: { resource: string; action: string }[];
  superAdmin?: boolean | null;
} = {}) {
  const events = makeEventBus();
  const sessions = mock<SessionResolver>({ resolveUserId: vi.fn(async () => userId) });
  const permissionResolver = grants
    ? mock<AdminPermissionResolver>({
        getGrants: vi.fn(async () => grants),
        isSuperAdmin: vi.fn(async () => superAdmin ?? null),
      })
    : undefined;
  const guard = new AdminGuard(db.drizzle, sessions, permissionResolver, events);
  return { guard, events };
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
        requestContext({ 'x-real-ip': '192.168.1.1', 'user-agent': 'Mozilla/5.0' }),
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

describe('AdminGuard.assertSuperAdmin (real PG)', () => {
  it('denies a role whose matrix grants everything but is not flagged super admin', async () => {
    const userId = await seedUser('admin');
    const { guard, events } = makeGuard({ userId, grants: [], superAdmin: false });

    await expect(guard.assertSuperAdmin(requestContext(ADMIN_HEADERS))).rejects.toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.unauthorized_access',
      expect.objectContaining({ resource: 'admin', action: 'super-admin' }),
    );
  });

  it('allows a DB-assigned super admin', async () => {
    const userId = await seedUser('admin');
    const { guard } = makeGuard({ userId, grants: [], superAdmin: true });

    await expect(guard.assertSuperAdmin(requestContext(ADMIN_HEADERS))).resolves.toMatchObject({
      userId,
    });
  });

  it('falls back to the static admin role when no resolver is bound (bootstrap)', async () => {
    const userId = await seedUser('admin');
    const { guard } = makeGuard({ userId });

    await expect(guard.assertSuperAdmin(requestContext(ADMIN_HEADERS))).resolves.toMatchObject({
      userId,
    });
  });

  it('denies a non-admin static role on the bootstrap path', async () => {
    const userId = await seedUser('support');
    const { guard } = makeGuard({ userId });

    await expect(guard.assertSuperAdmin(requestContext(ADMIN_HEADERS))).rejects.toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });
});
