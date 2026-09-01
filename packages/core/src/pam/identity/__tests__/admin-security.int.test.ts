import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb, seedUser } from '@openora/core/testing';
import { AdminSecurityConfigSchema } from '@openora/core/contracts';
import { user, session, twoFactor, adminTrustedDevice } from '../schema/index.js';
import { makeEventBus, makeIdentityReader } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  AdminSecurityService,
  SelfTwoFactorResetError,
} from '../service/admin-security.service.js';
import { SessionService } from '../service/session.service.js';
import { TrustedDeviceService } from '../service/trusted-device.service.js';

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

let db: TestDb;

function buildService() {
  const events = makeEventBus();
  const drizzle = db.drizzle;
  const trustedDevices = new TrustedDeviceService({ drizzle, events, trustedDeviceDays: 30 });
  const service = new AdminSecurityService({
    drizzle,
    events,
    sessions: new SessionService({ drizzle, events, identityReader: makeIdentityReader() }),
    trustedDevices,
    identityReader: makeIdentityReader(),
    config: AdminSecurityConfigSchema.parse({ requireTwoFactor: true, bindSessionToDevice: true }),
  });
  return { service, trustedDevices, events };
}

const seedSession = (userId: string, userAgent: string) =>
  db.drizzle.db
    .insert(session)
    .values({
      userId,
      token: crypto.randomUUID(),
      userAgent,
      expiresAt: new Date(Date.now() + 86_400_000),
      updatedAt: new Date(),
    })
    .returning({ id: session.id })
    .then(([row]) => row?.id ?? '');

async function isActive(sessionId: string) {
  const [row] = await db.drizzle.db
    .select({ expiresAt: session.expiresAt })
    .from(session)
    .where(eq(session.id, sessionId));
  return row !== undefined && row.expiresAt.getTime() > Date.now();
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await db.drizzle.db.execute(
    sql`TRUNCATE ${user}, ${session}, ${twoFactor}, ${adminTrustedDevice} RESTART IDENTITY CASCADE`,
  );
});

describe('AdminSecurityService.revokeTrustedDevice (real PG)', () => {
  it('ends the sessions the revoked device was holding', async () => {
    const admin = await seedUser(db, { name: 'Admin', email: 'admin@b.dev', role: 'admin' });
    const revokedSession = await seedSession(admin.id, CHROME_UA);
    const otherSession = await seedSession(admin.id, SAFARI_UA);
    const { service, trustedDevices } = buildService();
    const device = await trustedDevices.trust(admin.id, { ip: null, userAgent: CHROME_UA });
    if (!device) {
      throw new Error('trust() stored no device');
    }

    await service.revokeTrustedDevice(admin.id, device.id, admin.id);

    expect(await isActive(revokedSession)).toBe(false);
    expect(await isActive(otherSession)).toBe(true);
  });

  it('spares the session the revoke was issued from', async () => {
    const admin = await seedUser(db, { name: 'Admin', email: 'admin@b.dev', role: 'admin' });
    const callerSession = await seedSession(admin.id, CHROME_UA);
    const otherTab = await seedSession(admin.id, CHROME_UA);
    const { service, trustedDevices } = buildService();
    const device = await trustedDevices.trust(admin.id, { ip: null, userAgent: CHROME_UA });
    if (!device) {
      throw new Error('trust() stored no device');
    }

    await service.revokeTrustedDevice(admin.id, device.id, admin.id, undefined, callerSession);

    expect(await isActive(callerSession)).toBe(true);
    expect(await isActive(otherTab)).toBe(false);
    expect(await service.isTrustedDevice(admin.id, CHROME_UA)).toBe(false);
  });

  it('drops the trust so the device stops being listed', async () => {
    const admin = await seedUser(db, { name: 'Admin', email: 'admin@b.dev', role: 'admin' });
    const { service, trustedDevices } = buildService();
    const device = await trustedDevices.trust(admin.id, { ip: null, userAgent: CHROME_UA });
    if (!device) {
      throw new Error('trust() stored no device');
    }

    await service.revokeTrustedDevice(admin.id, device.id, admin.id);

    expect(await service.isTrustedDevice(admin.id, CHROME_UA)).toBe(false);
    expect(await service.listTrustedDevices(admin.id, CHROME_UA)).toEqual([]);
  });
});

describe('AdminSecurityService.resetTwoFactor (real PG)', () => {
  const enrol = async (userId: string) => {
    await db.drizzle.db
      .update(user)
      .set({ twoFactorEnabled: true, failedTwoFactorAttempts: 4 })
      .where(eq(user.id, userId));
    await db.drizzle.db
      .insert(twoFactor)
      .values({ userId, secret: 'seed-secret', backupCodes: '["aaaaa-bbbbb"]' });
  };

  it('returns the account to the unenrolled state', async () => {
    const admin = await seedUser(db, { name: 'Admin', email: 'admin@b.dev', role: 'admin' });
    const superAdmin = await seedUser(db, { name: 'Boss', email: 'boss@b.dev', role: 'admin' });
    await enrol(admin.id);
    const { service } = buildService();

    await service.resetTwoFactor(admin.id, superAdmin.id, 'lost authenticator');

    const status = await service.status(admin.id, CHROME_UA);
    expect(status.twoFactorEnabled).toBe(false);
    expect(status.enrollmentRequired).toBe(true);
    expect(status.lockedUntil).toBeNull();
  });

  it('takes the trusted devices and live sessions with it', async () => {
    const admin = await seedUser(db, { name: 'Admin', email: 'admin@b.dev', role: 'admin' });
    const superAdmin = await seedUser(db, { name: 'Boss', email: 'boss@b.dev', role: 'admin' });
    await enrol(admin.id);
    const chrome = await seedSession(admin.id, CHROME_UA);
    const safari = await seedSession(admin.id, SAFARI_UA);
    const { service, trustedDevices } = buildService();
    await trustedDevices.trust(admin.id, { ip: null, userAgent: CHROME_UA });

    await service.resetTwoFactor(admin.id, superAdmin.id, 'lost authenticator');

    expect(await isActive(chrome)).toBe(false);
    expect(await isActive(safari)).toBe(false);
    expect(await service.isTrustedDevice(admin.id, CHROME_UA)).toBe(false);
  });

  it('refuses to reset the acting admin’s own second factor', async () => {
    const admin = await seedUser(db, { name: 'Admin', email: 'admin@b.dev', role: 'admin' });
    await enrol(admin.id);
    const { service } = buildService();

    await expect(service.resetTwoFactor(admin.id, admin.id, 'self')).rejects.toThrow(
      SelfTwoFactorResetError,
    );
  });
});
