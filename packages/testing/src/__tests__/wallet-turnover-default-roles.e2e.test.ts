import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { WALLET_COMMANDS } from '@openora/core/contracts';
import { user } from '@openora/core/pam/schema/identity';
import { adminRole, adminRoleAssignment } from '@openora/core/iam/schema';
import {
  bootE2e,
  closeE2e,
  registerAndMaterializePlayer,
  type TestApp,
  type TestDb,
} from '../index.js';

const fixture = (name: string) => fileURLToPath(new URL(name, import.meta.url));

let db: TestDb;
let app: TestApp;

const drizzle = () => app.container.get(DRIZZLE).db;

const ROLES = [
  { key: 'admin', view: true, viewConfig: true, write: false },
  { key: 'sportsbook-manager', view: false, viewConfig: true, write: false },
  { key: 'payments-manager', view: true, viewConfig: false, write: false },
  { key: 'risk-fraud-manager', view: true, viewConfig: false, write: false },
  { key: 'finance-accounting', view: true, viewConfig: false, write: false },
  { key: 'support-manager', view: true, viewConfig: false, write: false },
  { key: 'customer-support-agent', view: true, viewConfig: false, write: false },
  { key: 'compliance-manager', view: true, viewConfig: true, write: true },
  { key: 'kyc-aml-officer', view: true, viewConfig: true, write: true },
] as const;

const status = (allowed: boolean) => (allowed ? 200 : 403);

async function player() {
  return registerAndMaterializePlayer(app, { email: `turnover-roles-${randomUUID()}@e2e.test` });
}

async function owing() {
  const registered = await player();
  await drizzle().transaction(async (tx) => {
    const commands = app.container.get(WALLET_COMMANDS);
    if (!commands.addTurnoverRequirement) {
      throw new Error('addTurnoverRequirement is not bound');
    }
    await commands.addTurnoverRequirement(tx, {
      userId: registered.userId,
      currency: 'USD',
      requiredInCurrency: '10',
      source: 'grant_conversion',
      sourceRef: randomUUID(),
    });
  });
  return registered.userId;
}

async function staffWithRole(key: string) {
  const staff = await player();
  await drizzle().update(user).set({ role: 'admin' }).where(eq(user.id, staff.userId));
  const [role] = await drizzle().select().from(adminRole).where(eq(adminRole.key, key));
  if (!role) {
    throw new Error(`no seeded role ${key}`);
  }
  await drizzle().insert(adminRoleAssignment).values({ userId: staff.userId, roleId: role.id });
  return staff.client;
}

beforeAll(async () => {
  ({ db, app } = await bootE2e({
    plugins: [
      ...(await loadExtensions()),
      {
        id: 'testing-wallet-turnover-config',
        path: fixture('./support/test-wallet-turnover-config-plugin.ts'),
      },
    ],
  }));
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

describe('turnover access of the seeded staff roles', () => {
  it.each(ROLES)('gives $key the access its matrix names', async (role) => {
    const staff = await staffWithRole(role.key);
    const target = await owing();

    expect((await staff.get(`/wallet/admin/players/${target}/turnover`)).status).toBe(
      status(role.view),
    );
    expect((await staff.get(`/wallet/admin/players/${target}/turnover/entries`)).status).toBe(
      status(role.view),
    );
    expect((await staff.get('/wallet/admin/turnover-config')).status).toBe(status(role.viewConfig));
    expect(
      (await staff.put('/wallet/admin/turnover-config', { productPercent: { casino: 100 } }))
        .status,
    ).toBe(status(role.write));
    const clear = await staff.post(`/wallet/admin/players/${target}/turnover/clear`, {
      userId: target,
      reason: 'seeded role clear attempt',
    });
    expect(clear.status).toBe(status(role.write));
    const own = await player();
    expect((await own.client.get('/wallet/turnover')).status).toBe(200);
  });
});
