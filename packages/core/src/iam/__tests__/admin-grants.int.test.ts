import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { statement } from '@openora/core/server';
import { createTestDb, type TestDb } from '../../testing/real-infra.js';
import { seedUser } from '../../testing/seed-player.js';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { migrate as migrateIam } from '../migrate.js';
import { adminRole, adminRoleAssignment, adminRolePermission } from '../schema/index.js';
import { loadAdminGrants } from '../shared/admin-grants.js';
import { activeSuperAdminHoldings } from '../shared/super-admin-retention.js';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb([migrateIdentity, migrateIam]);
}, 120_000);

afterAll(() => testDb.drop());

const db = () => testDb.drizzle.db;

type Level = 'no_access' | 'read' | 'read_write';

async function seedRole(
  levels: Record<string, Level> = {},
  { isSuperAdmin = false }: { isSuperAdmin?: boolean } = {},
) {
  const [role] = await db()
    .insert(adminRole)
    .values({ name: `role ${randomUUID()}`, isSuperAdmin })
    .returning();
  if (!role) {
    throw new Error('role insert returned no row');
  }
  const cells = Object.entries(levels);
  if (cells.length > 0) {
    await db()
      .insert(adminRolePermission)
      .values(cells.map(([resource, level]) => ({ roleId: role.id, resource, level })));
  }
  return role;
}

async function seedHolder(
  roleIds: string[],
  account: Partial<Parameters<typeof seedUser>[1]> = {},
) {
  const holder = await seedUser(testDb, { role: 'admin', ...account });
  if (roleIds.length > 0) {
    await db()
      .insert(adminRoleAssignment)
      .values(roleIds.map((roleId) => ({ userId: holder.id, roleId })));
  }
  return holder;
}

const bySlot = (grants: { resource: string; action: string }[]) =>
  grants.map(({ resource, action }) => `${resource}:${action}`).sort();

const everyGrant = Object.entries(statement).flatMap(([resource, actions]) =>
  Array.from(actions, (action: string) => `${resource}:${action}`),
);

describe('loadAdminGrants', () => {
  it('a super admin role yields every grant of every resource', async () => {
    const superRole = await seedRole({ audit: 'read' }, { isSuperAdmin: true });
    const holder = await seedHolder([superRole.id]);

    const grants = (await loadAdminGrants(db(), [holder.id])).get(holder.id);

    expect(bySlot(grants ?? [])).toEqual([...everyGrant].sort());
  });

  it('two roles yield the union of their grants without duplicates', async () => {
    const first = await seedRole({ audit: 'read_write', player: 'read' });
    const second = await seedRole({ audit: 'read', report: 'read' });
    const holder = await seedHolder([first.id, second.id]);

    const grants = (await loadAdminGrants(db(), [holder.id])).get(holder.id);

    expect(bySlot(grants ?? [])).toEqual(
      ['audit:view', 'audit:export', 'player:view', 'report:view'].sort(),
    );
  });

  it('a user with no assignment is absent from the result', async () => {
    const role = await seedRole({ audit: 'read' });
    const assigned = await seedHolder([role.id]);
    const unassigned = await seedHolder([]);

    const result = await loadAdminGrants(db(), [assigned.id, unassigned.id]);

    expect([...result.keys()]).toEqual([assigned.id]);
    expect(result.has(unassigned.id)).toBe(false);
  });

  it('a no_access cell yields no grant', async () => {
    const role = await seedRole({ audit: 'no_access', player: 'read' });
    const holder = await seedHolder([role.id]);

    const grants = (await loadAdminGrants(db(), [holder.id])).get(holder.id);

    expect(bySlot(grants ?? [])).toEqual(['player:view']);
  });
});

describe('super admin retention', () => {
  it('only active admin accounts count as super admin holdings', async () => {
    const superRole = await seedRole({}, { isSuperAdmin: true });
    const plainRole = await seedRole({ audit: 'read' });
    const active = await seedHolder([superRole.id]);
    const plainHolder = await seedHolder([plainRole.id]);

    const holdings = await db().transaction((tx) => activeSuperAdminHoldings(tx));

    expect(holdings).toContainEqual({ userId: active.id, roleId: superRole.id });
    expect(holdings.map((holding) => holding.userId)).not.toContain(plainHolder.id);
    expect(holdings.filter((holding) => holding.roleId === plainRole.id)).toEqual([]);
  });

  it('a deactivated or player account holding the super admin role does not count', async () => {
    const superRole = await seedRole({}, { isSuperAdmin: true });
    const counted = await seedHolder([superRole.id]);
    const deactivated = await seedHolder([superRole.id], { isActive: false });
    const player = await seedHolder([superRole.id], { role: 'player' });

    const holdings = await db().transaction((tx) => activeSuperAdminHoldings(tx));

    const mine = holdings.filter((holding) => holding.roleId === superRole.id);
    expect(mine.map((holding) => holding.userId)).toEqual([counted.id]);
    expect(mine.map((holding) => holding.userId)).not.toContain(deactivated.id);
    expect(mine.map((holding) => holding.userId)).not.toContain(player.id);
  });
});
