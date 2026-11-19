import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import * as z from 'zod';
import { call } from '@orpc/server';
import {
  Container,
  createInternalClient,
  DRIZZLE,
  EVENT_BUS,
  ModuleRegistryImpl,
  type CoreTokenCatalog,
  type InternalClient,
} from '@openora/core/server';
import {
  ADMIN_PERMISSION_RESOLVER,
  ADMIN_PERMISSION_ROUTES,
  AdminPermissionWire,
} from '@openora/core/contracts';
import { createTestDb, seedUser, type TestDb } from '@openora/core/testing';
import { migrate as migrateIam } from '@openora/core/iam/migrate';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { user } from '@openora/core/pam/schema/identity';
import { makeEventBus, NO_CLIENT_META } from '../../../testing/mock.js';
import { adminRole, adminRoleAssignment, adminRolePermission } from '@openora/core/iam/schema';
import iamPlugin from '@openora/core/iam/plugin';
import { RemoteAdminPermissionResolver } from '../service/remote-admin-permission-resolver.service.js';

const CHAT = 'chat';

type Procedure = Parameters<typeof call>[0];
type PermissionsRouter = { adminGrants: Procedure; adminSuperAdmin: Procedure };

let db: TestDb;
const savedCallers = process.env['ADMIN_PERMISSION_CALLERS'];

/** The iam owner's internal routes, registered for real and served in process as `caller`. */
function iamService(caller: string, callers = CHAT) {
  process.env['ADMIN_PERMISSION_CALLERS'] = callers;
  const container = new Container<CoreTokenCatalog>();
  container.register(DRIZZLE, () => db.drizzle);
  container.register(EVENT_BUS, () => makeEventBus());
  const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
  iamPlugin.register(registry);
  const router = registry.routers.getInternal().get('iam')?.(container) as PermissionsRouter;
  const context = {
    request: { headers: {} as Record<string, string | string[] | undefined> },
    clientMeta: NO_CLIENT_META,
    internalCaller: caller,
  };
  const routes = {
    [ADMIN_PERMISSION_ROUTES.grants]: [router.adminGrants, AdminPermissionWire.grants],
    [ADMIN_PERMISSION_ROUTES.superAdmin]: [router.adminSuperAdmin, AdminPermissionWire.superAdmin],
  } as const;
  const client: InternalClient = {
    async request(_method, path, body) {
      const [procedure, wire] = routes[path as keyof typeof routes];
      const reply = await call(procedure, wire.input.parse(body), { context });
      return JSON.parse(JSON.stringify(reply));
    },
  };
  return { client, local: container.get(ADMIN_PERMISSION_RESOLVER) };
}

async function seedAdmin(opts: { superAdmin: boolean; grant?: [string, 'read' | 'read_write'] }) {
  const userId = randomUUID();
  await seedUser(db, { id: userId, email: `${userId}@admin.test`, role: 'admin', isActive: true });
  const [role] = await db.drizzle.db
    .insert(adminRole)
    .values({ name: `Role ${userId}`, isSuperAdmin: opts.superAdmin })
    .returning();
  await db.drizzle.db.insert(adminRoleAssignment).values({ userId, roleId: role.id });
  if (opts.grant) {
    await db.drizzle.db
      .insert(adminRolePermission)
      .values({ roleId: role.id, resource: opts.grant[0], level: opts.grant[1] });
  }
  return userId;
}

/** A real signed client whose network is `fetch`, timing out after 20ms. */
function overNetwork(fetch: (url: URL, init: RequestInit) => Promise<Response>) {
  vi.stubGlobal('fetch', fetch);
  return new RemoteAdminPermissionResolver(
    createInternalClient({
      baseUrl: 'http://iam.test',
      serviceName: CHAT,
      audience: 'monolith',
      secrets: 'x'.repeat(32),
      timeoutMs: 20,
    }),
  );
}

const stalled = (_url: URL, init: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  });

beforeAll(async () => {
  db = await createTestDb([migrateIam, migrateIdentity]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${adminRole}, ${adminRolePermission}, ${adminRoleAssignment}, ${user} RESTART IDENTITY CASCADE`,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedCallers === undefined) {
    delete process.env['ADMIN_PERMISSION_CALLERS'];
  } else {
    process.env['ADMIN_PERMISSION_CALLERS'] = savedCallers;
  }
});

describe('RemoteAdminPermissionResolver against the iam internal routes', () => {
  it('answers grants and super-admin as the local resolver does', async () => {
    const { client, local } = iamService(CHAT);
    const remote = new RemoteAdminPermissionResolver(client);
    const ops = await seedAdmin({ superAdmin: false, grant: ['player', 'read'] });
    const root = await seedAdmin({ superAdmin: true });
    const unassigned = randomUUID();

    for (const id of [ops, root, unassigned]) {
      expect(await remote.getGrants(id)).toEqual(await local.getGrants(id));
      expect(await remote.isSuperAdmin(id)).toBe(await local.isSuperAdmin(id));
    }
    expect((await remote.getGrants(ops)).length).toBeGreaterThan(0);
    expect(await remote.isSuperAdmin(root)).toBe(true);
    expect(await remote.getGrants(unassigned)).toEqual([]);
  });

  it('refuses a caller that is not on ADMIN_PERMISSION_CALLERS, and every caller while it is unset', async () => {
    const admin = await seedAdmin({ superAdmin: true });

    for (const service of [iamService('wallet'), iamService(CHAT, '')]) {
      const remote = new RemoteAdminPermissionResolver(service.client);

      await expect(remote.getGrants(admin)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(remote.isSuperAdmin(admin)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('throws instead of reading as no grants when iam is unreachable or slow', async () => {
    const admin = randomUUID();

    for (const remote of [
      overNetwork(stalled),
      overNetwork(async () => new Response('{}', { status: 502 })),
      overNetwork(() => Promise.reject(new TypeError('fetch failed'))),
    ]) {
      await expect(remote.getGrants(admin)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      await expect(remote.isSuperAdmin(admin)).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
      });
    }
  });

  it('rejects a reply that is not the wire shape', async () => {
    const garbled = overNetwork(
      async () =>
        new Response(JSON.stringify({ grants: 'all' }), {
          headers: { 'content-type': 'application/json' },
        }),
    );

    await expect(garbled.getGrants(randomUUID())).rejects.toBeInstanceOf(z.ZodError);
  });
});
