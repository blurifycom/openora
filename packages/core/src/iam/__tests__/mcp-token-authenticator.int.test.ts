import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createTestDb, seedUser, type TestDb } from '@openora/core/testing';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { account, user } from '@openora/core/pam/schema/identity';
import { migrate as migrateIam } from '../migrate.js';
import { mcpToken } from '../schema/index.js';
import { DrizzleMcpTokenAuthenticator } from '../adapters/mcp-token-authenticator.js';
import { generateMcpToken, hashMcpToken, mcpTokenDisplayPrefix } from '../shared/mcp-token.js';

const HOUR_MS = 60 * 60 * 1000;
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * HOUR_MS);

let db: TestDb;
let authenticator: DrizzleMcpTokenAuthenticator;

beforeAll(async () => {
  db = await createTestDb([migrateIam, migrateIdentity]);
  authenticator = new DrizzleMcpTokenAuthenticator(db.drizzle);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${mcpToken}, ${user} RESTART IDENTITY CASCADE`);
});

async function seedAdminWithPassword(passwordSetAt: Date) {
  const admin = await seedUser(db, { role: 'admin' });
  await db.drizzle.db.insert(account).values({
    accountId: admin.id,
    providerId: 'credential',
    userId: admin.id,
    password: 'stored-hash',
    updatedAt: passwordSetAt,
  });
  return admin.id;
}

async function changePasswordAt(adminUserId: string, at: Date) {
  await db.drizzle.db
    .update(account)
    .set({ updatedAt: at })
    .where(and(eq(account.userId, adminUserId), eq(account.providerId, 'credential')));
}

async function seedToken(
  over: Partial<typeof mcpToken.$inferInsert> = {},
  plaintext = generateMcpToken(),
) {
  const [row] = await db.drizzle.db
    .insert(mcpToken)
    .values({
      adminUserId: randomUUID(),
      label: 'Laptop',
      tokenHash: hashMcpToken(plaintext),
      tokenPrefix: mcpTokenDisplayPrefix(plaintext),
      expiresAt: hoursFromNow(24),
      ...over,
    })
    .returning();
  return { row, plaintext };
}

async function storedToken(id: string) {
  const [row] = await db.drizzle.db.select().from(mcpToken).where(eq(mcpToken.id, id));
  return row;
}

describe('DrizzleMcpTokenAuthenticator.authenticate (real PG)', () => {
  it('accepts an active token and names the token and its admin', async () => {
    const { row, plaintext } = await seedToken();

    expect(await authenticator.authenticate(plaintext)).toEqual({
      ok: true,
      tokenId: row.id,
      adminId: row.adminUserId,
    });
  });

  it('answers unknown for a well-formed token that was never issued', async () => {
    await seedToken();

    expect(await authenticator.authenticate(generateMcpToken())).toEqual({
      ok: false,
      reason: 'unknown',
    });
  });

  it.each(['', 'not-a-token', 'ora_mcp_short', `Bearer ${generateMcpToken()}`])(
    'answers unknown for the malformed bearer %j even when its hash is on file',
    async (bearer) => {
      await seedToken({}, bearer);

      expect(await authenticator.authenticate(bearer)).toEqual({ ok: false, reason: 'unknown' });
    },
  );

  it('refuses a revoked token as revoked, naming the token and its admin', async () => {
    const { row, plaintext } = await seedToken({
      revokedAt: hoursFromNow(-1),
      revokeReason: 'manual',
    });

    expect(await authenticator.authenticate(plaintext)).toEqual({
      ok: false,
      reason: 'revoked',
      tokenId: row.id,
      adminId: row.adminUserId,
    });
  });

  it('refuses a token past its expiry as expired', async () => {
    const { row, plaintext } = await seedToken({ expiresAt: hoursFromNow(-1) });

    expect(await authenticator.authenticate(plaintext)).toEqual({
      ok: false,
      reason: 'expired',
      tokenId: row.id,
      adminId: row.adminUserId,
    });
  });

  it('refuses a token that is both revoked and expired as revoked', async () => {
    const { plaintext } = await seedToken({
      expiresAt: hoursFromNow(-2),
      revokedAt: hoursFromNow(-1),
      revokeReason: 'sessions_revoked',
    });

    expect(await authenticator.authenticate(plaintext)).toMatchObject({
      ok: false,
      reason: 'revoked',
    });
  });
});

describe("DrizzleMcpTokenAuthenticator against the admin's password changes (real PG)", () => {
  it('refuses an unrevoked token issued before the latest password change', async () => {
    const adminId = await seedAdminWithPassword(hoursFromNow(-48));
    const { row, plaintext } = await seedToken({
      adminUserId: adminId,
      createdAt: hoursFromNow(-2),
    });
    await changePasswordAt(adminId, hoursFromNow(-1));

    expect(await authenticator.authenticate(plaintext)).toEqual({
      ok: false,
      reason: 'credentials_changed',
      tokenId: row.id,
      adminId,
    });
    expect(await storedToken(row.id)).toMatchObject({ revokedAt: null, revokeReason: null });
  });

  it('accepts a token issued after the latest password change', async () => {
    const adminId = await seedAdminWithPassword(hoursFromNow(-2));
    const { row, plaintext } = await seedToken({
      adminUserId: adminId,
      createdAt: hoursFromNow(-1),
    });

    expect(await authenticator.authenticate(plaintext)).toEqual({
      ok: true,
      tokenId: row.id,
      adminId,
    });
  });

  it('reads the latest stamp when the admin holds more than one password account', async () => {
    const adminId = await seedAdminWithPassword(hoursFromNow(-48));
    await db.drizzle.db.insert(account).values({
      accountId: `second-${adminId}`,
      providerId: 'credential',
      userId: adminId,
      password: 'stored-hash',
      updatedAt: hoursFromNow(-1),
    });
    const { plaintext } = await seedToken({ adminUserId: adminId, createdAt: hoursFromNow(-2) });

    expect(await authenticator.authenticate(plaintext)).toMatchObject({
      ok: false,
      reason: 'credentials_changed',
    });
  });

  it("ignores a later write to the admin's account at another provider", async () => {
    const adminId = await seedAdminWithPassword(hoursFromNow(-48));
    await db.drizzle.db.insert(account).values({
      accountId: `oidc-${adminId}`,
      providerId: 'oidc',
      userId: adminId,
      updatedAt: hoursFromNow(-1),
    });
    const { plaintext } = await seedToken({ adminUserId: adminId, createdAt: hoursFromNow(-2) });

    expect(await authenticator.authenticate(plaintext)).toMatchObject({ ok: true });
  });

  it("ignores another admin's password change", async () => {
    const adminId = await seedAdminWithPassword(hoursFromNow(-48));
    await seedAdminWithPassword(hoursFromNow(-1));
    const { plaintext } = await seedToken({ adminUserId: adminId, createdAt: hoursFromNow(-2) });

    expect(await authenticator.authenticate(plaintext)).toMatchObject({ ok: true });
  });
});

describe('DrizzleMcpTokenAuthenticator.recordCall (real PG)', () => {
  it('counts each call and stamps the last use with the database clock', async () => {
    const { row } = await seedToken();
    const { rows } = await db.drizzle.db.execute<{ now: string }>(sql`select now() as now`);
    const before = new Date(rows[0]?.now ?? 0);

    await authenticator.recordCall(row.id);
    await authenticator.recordCall(row.id);

    const stored = await storedToken(row.id);
    expect(stored.callCount).toBe(2);
    expect(stored.lastUsedAt?.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it('leaves every other token untouched', async () => {
    const { row } = await seedToken();
    const { row: other } = await seedToken();

    await authenticator.recordCall(row.id);

    expect(await storedToken(other.id)).toMatchObject({ callCount: 0, lastUsedAt: null });
  });
});
