import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { CountryRuleSchema, GlobalKycConfigSchema } from '@openora/core/compliance/contract';
import { adminRole, adminRoleAssignment } from '@openora/core/iam/schema';
import { user } from '@openora/core/pam/schema/identity';
import {
  bootTestApp,
  registerAndMaterializePlayer,
  seedMinimal,
  setupTestDb,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let complianceManager: TestClient;
let complianceManagerId: string;
let player: TestClient;
let kycAmlOfficer: TestClient;

async function assignRole(userId: string, roleKey: string) {
  const drizzle = app.container.get(DRIZZLE).db;
  await drizzle.update(user).set({ role: 'admin' }).where(eq(user.id, userId));
  const [role] = await drizzle
    .select({ id: adminRole.id })
    .from(adminRole)
    .where(eq(adminRole.key, roleKey));
  if (!role) {
    throw new Error(`The seeded ${roleKey} role is unavailable`);
  }
  await drizzle
    .insert(adminRoleAssignment)
    .values({ userId, roleId: role.id })
    .onConflictDoNothing();
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });

  const manager = await registerAndMaterializePlayer(app, {
    email: `regulatory-manager-${randomUUID()}@e2e.test`,
  });
  await assignRole(manager.userId, 'compliance-manager');
  complianceManager = manager.client;
  complianceManagerId = manager.userId;

  const ordinaryPlayer = await registerAndMaterializePlayer(app, {
    email: `regulatory-player-${randomUUID()}@e2e.test`,
  });
  player = ordinaryPlayer.client;

  const officer = await registerAndMaterializePlayer(app, {
    email: `regulatory-kyc-officer-${randomUUID()}@e2e.test`,
  });
  await assignRole(officer.userId, 'kyc-aml-officer');
  kycAmlOfficer = officer.client;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('regulatory overview routes', () => {
  it('allows the seeded compliance-manager grant to mutate and read country and global KYC settings', async () => {
    const initialRules = await complianceManager.get('/compliance/country-rules');
    expect(initialRules.status).toBe(200);
    expect(CountryRuleSchema.array().parse(await initialRules.json())).toEqual([]);

    const countryResponse = await complianceManager.request('/compliance/country-rules', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-real-ip': '203.0.113.8',
        'user-agent': 'RegulatoryOverviewE2E/1.0',
      },
      body: JSON.stringify({
        countryCode: 'FR',
        blacklisted: true,
        redirectIp: false,
        kycRequired: true,
        expectedUpdatedAt: null,
        confirm: true,
      }),
    });
    expect(countryResponse.status).toBe(200);
    const countryRule = CountryRuleSchema.parse(await countryResponse.json());
    expect(countryRule).toMatchObject({
      countryCode: 'FR',
      blacklisted: true,
      redirectIp: false,
      kycRequired: true,
      updatedBy: complianceManagerId,
    });

    const listedRules = await complianceManager.get('/compliance/country-rules');
    expect(listedRules.status).toBe(200);
    expect(CountryRuleSchema.array().parse(await listedRules.json())).toEqual([countryRule]);

    const initialGlobal = await complianceManager.get('/compliance/global-kyc');
    expect(initialGlobal.status).toBe(200);
    expect(GlobalKycConfigSchema.parse(await initialGlobal.json())).toEqual({
      enabled: true,
      updatedAt: null,
      updatedBy: null,
    });

    const globalResponse = await complianceManager.put('/compliance/global-kyc', {
      enabled: false,
      confirm: true,
      expectedUpdatedAt: null,
    });
    expect(globalResponse.status).toBe(200);
    const globalKyc = GlobalKycConfigSchema.parse(await globalResponse.json());
    expect(globalKyc).toMatchObject({ enabled: false, updatedBy: complianceManagerId });

    const countryAudits = await app.container
      .get(DRIZZLE)
      .db.select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'compliance.country_rule.setting_changed'),
          eq(auditLog.resourceId, 'FR'),
        ),
      );
    expect(countryAudits).toHaveLength(1);
    expect(countryAudits[0]).toMatchObject({
      actorId: complianceManagerId,
      actorType: 'admin',
      resourceType: 'country-rule',
      ip: '203.0.113.8',
      userAgent: 'RegulatoryOverviewE2E/1.0',
      before: { setting: 'blacklisted', value: false },
      after: { setting: 'blacklisted', value: true },
    });

    const globalAudits = await app.container
      .get(DRIZZLE)
      .db.select()
      .from(auditLog)
      .where(eq(auditLog.action, 'compliance.global_kyc.set'));
    expect(globalAudits).toHaveLength(1);
    expect(globalAudits[0]).toMatchObject({
      actorId: complianceManagerId,
      actorType: 'admin',
      resourceType: 'global-kyc-config',
      resourceId: 'global',
      before: { enabled: true },
      after: { enabled: false },
    });
  });

  it('rejects a player from every regulatory overview route', async () => {
    expect((await player.get('/compliance/country-rules')).status).toBe(403);
    expect(
      (
        await player.put('/compliance/country-rules', {
          countryCode: 'DE',
          blacklisted: false,
          redirectIp: false,
          kycRequired: true,
          expectedUpdatedAt: null,
        })
      ).status,
    ).toBe(403);
    expect((await player.get('/compliance/global-kyc')).status).toBe(403);
    expect(
      (
        await player.put('/compliance/global-kyc', {
          enabled: true,
          confirm: true,
          expectedUpdatedAt: null,
        })
      ).status,
    ).toBe(403);
  });

  it('rejects the KYC and AML officer from every regulatory overview route', async () => {
    expect((await kycAmlOfficer.get('/compliance/country-rules')).status).toBe(403);
    expect(
      (
        await kycAmlOfficer.put('/compliance/country-rules', {
          countryCode: 'DE',
          blacklisted: false,
          redirectIp: false,
          kycRequired: true,
          expectedUpdatedAt: null,
        })
      ).status,
    ).toBe(403);
    expect((await kycAmlOfficer.get('/compliance/global-kyc')).status).toBe(403);
    expect(
      (
        await kycAmlOfficer.put('/compliance/global-kyc', {
          enabled: true,
          confirm: true,
          expectedUpdatedAt: null,
        })
      ).status,
    ).toBe(403);
  });
});
