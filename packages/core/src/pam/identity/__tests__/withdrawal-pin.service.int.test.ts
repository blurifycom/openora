import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  createTestDb,
  createTestRedis,
  seedUser as insertUser,
  type TestDb,
  type TestRedis,
} from '@openora/core/testing';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { RedisRateLimiter, type Auth } from '@openora/core/server';
import { SetWithdrawalPinInputSchema, type RateLimiterAdapter } from '@openora/core/contracts';
import { account, user } from '../schema/index.js';
import { WithdrawalPinService } from '../service/withdrawal-pin.service.js';
import { makeEventBus, makeIdentityReader, mock, NO_CLIENT_META } from '../../../testing/mock.js';

const PASSWORD = 'current-password';
const HMAC_SECRET = 'a'.repeat(32);
const PIN = '1234';

let db: TestDb;

const allowLimiter = (): RateLimiterAdapter =>
  mock<RateLimiterAdapter>({
    consume: vi.fn().mockResolvedValue({ allowed: true, retryAfterMs: 0 }),
    reset: vi.fn(),
  });

function build({
  passwordMatches = true,
  limiter,
}: { passwordMatches?: boolean; limiter?: RateLimiterAdapter } = {}) {
  const events = makeEventBus();
  const auth = mock<Auth>({
    $context: Promise.resolve({
      password: { verify: vi.fn().mockResolvedValue(passwordMatches) },
    }),
    api: { verifyTOTP: vi.fn().mockResolvedValue(new Response(null, { status: 200 })) },
  });
  const svc = new WithdrawalPinService({
    drizzle: db.drizzle,
    events,
    limiter: limiter ?? allowLimiter(),
    auth,
    identityReader: makeIdentityReader(),
    hmacSecret: HMAC_SECRET,
  });
  return { svc, events, auth };
}

async function seedAuthenticatedUser(
  overrides: { role?: string; email?: string; twoFactorEnabled?: boolean } = {},
) {
  const accountUser = await insertUser(db, {
    name: 'A',
    email: overrides.email ?? `withdrawal-pin-${randomUUID()}@test.dev`,
    ...(overrides.role ? { role: overrides.role } : {}),
    ...(overrides.twoFactorEnabled !== undefined
      ? { twoFactorEnabled: overrides.twoFactorEnabled }
      : {}),
  });
  await db.drizzle.db.insert(account).values({
    userId: accountUser.id,
    accountId: accountUser.id,
    providerId: 'credential',
    password: 'stored-password-hash',
  });
  return accountUser;
}

async function readUser(userId: string) {
  const [row] = await db.drizzle.db.select().from(user).where(eq(user.id, userId));
  return row;
}

beforeAll(async () => {
  db = await createTestDb([migrateIdentity]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${user}, ${account} RESTART IDENTITY CASCADE`);
});

describe('WithdrawalPinService (real PG)', () => {
  it('refuses a non-player role, leaves the row untouched, and audits the denial', async () => {
    const accountUser = await seedAuthenticatedUser({ role: 'admin' });
    const { svc, events } = build();

    await expect(
      svc.set(
        accountUser.id,
        { pin: PIN, confirmPin: PIN, currentPassword: PASSWORD },
        {},
        NO_CLIENT_META,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect((await readUser(accountUser.id))?.withdrawalPinHash).toBeNull();
    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.unauthorized_access',
      expect.objectContaining({
        userId: accountUser.id,
        resource: 'identity.security.withdrawal_pin',
        action: 'set',
        role: 'admin',
      }),
    );
  });

  it('sets a PIN for the first time', async () => {
    const accountUser = await seedAuthenticatedUser();
    const { svc, events } = build();

    const controls = await svc.set(
      accountUser.id,
      { pin: PIN, confirmPin: PIN, currentPassword: PASSWORD },
      {},
      NO_CLIENT_META,
    );

    expect(controls.withdrawalPinSet).toBe(true);
    const row = await readUser(accountUser.id);
    expect(row?.withdrawalPinHash).not.toBeNull();
    expect(row?.withdrawalPinSetAt).not.toBeNull();
    expect(events.emit).toHaveBeenCalledWith(
      'identity.security.withdrawal_pin.set',
      expect.objectContaining({ userId: accountUser.id, wasAlreadySet: false }),
    );
  });

  it('changes an existing PIN, overwriting the hash and flagging wasAlreadySet', async () => {
    const accountUser = await seedAuthenticatedUser();
    const { svc, events } = build();
    await svc.set(
      accountUser.id,
      { pin: PIN, confirmPin: PIN, currentPassword: PASSWORD },
      {},
      NO_CLIENT_META,
    );
    const firstHash = (await readUser(accountUser.id))?.withdrawalPinHash;

    await svc.set(
      accountUser.id,
      { pin: '5678', confirmPin: '5678', currentPassword: PASSWORD },
      {},
      NO_CLIENT_META,
    );

    const secondHash = (await readUser(accountUser.id))?.withdrawalPinHash;
    expect(secondHash).not.toEqual(firstHash);
    expect(events.emit).toHaveBeenCalledWith(
      'identity.security.withdrawal_pin.set',
      expect.objectContaining({ userId: accountUser.id, wasAlreadySet: true }),
    );
  });

  it('rejects a wrong current password, leaves the row untouched, and emits nothing', async () => {
    const accountUser = await seedAuthenticatedUser();
    const { svc, events } = build({ passwordMatches: false });

    await expect(
      svc.set(
        accountUser.id,
        { pin: PIN, confirmPin: PIN, currentPassword: 'wrong-password' },
        {},
        NO_CLIENT_META,
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect((await readUser(accountUser.id))?.withdrawalPinHash).toBeNull();
    expect(events.emit).not.toHaveBeenCalledWith(
      'identity.security.withdrawal_pin.set',
      expect.anything(),
    );
  });

  it('requires a fresh authenticator code once 2FA is enabled', async () => {
    const accountUser = await seedAuthenticatedUser({ twoFactorEnabled: true });
    const { svc } = build();

    await expect(
      svc.set(
        accountUser.id,
        { pin: PIN, confirmPin: PIN, currentPassword: PASSWORD },
        {},
        NO_CLIENT_META,
      ),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE_CONTENT' });
  });

  it('removes an existing PIN with no reauthentication and audits by event', async () => {
    const accountUser = await seedAuthenticatedUser();
    const { svc, events } = build();
    await svc.set(
      accountUser.id,
      { pin: PIN, confirmPin: PIN, currentPassword: PASSWORD },
      {},
      NO_CLIENT_META,
    );

    const controls = await svc.remove(accountUser.id, NO_CLIENT_META);

    expect(controls.withdrawalPinSet).toBe(false);
    const row = await readUser(accountUser.id);
    expect(row?.withdrawalPinHash).toBeNull();
    expect(row?.withdrawalPinSetAt).toBeNull();
    expect(events.emit).toHaveBeenCalledWith(
      'identity.security.withdrawal_pin.removed',
      expect.objectContaining({ userId: accountUser.id }),
    );
  });

  it('no-ops removing an already-unset PIN, without emitting an event', async () => {
    const accountUser = await seedAuthenticatedUser();
    const { svc, events } = build();

    const controls = await svc.remove(accountUser.id, NO_CLIENT_META);

    expect(controls.withdrawalPinSet).toBe(false);
    expect(events.emit).not.toHaveBeenCalledWith(
      'identity.security.withdrawal_pin.removed',
      expect.anything(),
    );
  });
});

describe('WithdrawalPinService - input validation (unit)', () => {
  it('rejects a mismatched pin/confirmPin', () => {
    const result = SetWithdrawalPinInputSchema.safeParse({
      pin: '1234',
      confirmPin: '4321',
      currentPassword: 'password123',
    });
    expect(result.success).toBe(false);
  });
});

describe('WithdrawalPinService - rate limiting (real Redis + real PG)', () => {
  let redis: TestRedis;

  beforeAll(async () => {
    redis = await createTestRedis();
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await redis.flush();
  });

  it('rejects the 6th set() within the window with a 429', async () => {
    const accountUser = await seedAuthenticatedUser();
    const { svc } = build({ limiter: new RedisRateLimiter(redis.client) });

    for (let i = 0; i < 5; i++) {
      await svc.set(
        accountUser.id,
        { pin: PIN, confirmPin: PIN, currentPassword: PASSWORD },
        {},
        NO_CLIENT_META,
      );
    }

    await expect(
      svc.set(
        accountUser.id,
        { pin: PIN, confirmPin: PIN, currentPassword: PASSWORD },
        {},
        NO_CLIENT_META,
      ),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('rejects the 6th remove() within the same per-user budget', async () => {
    const accountUser = await seedAuthenticatedUser();
    const { svc } = build({ limiter: new RedisRateLimiter(redis.client) });

    for (let i = 0; i < 5; i++) {
      await svc.remove(accountUser.id, NO_CLIENT_META);
    }

    await expect(svc.remove(accountUser.id, NO_CLIENT_META)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
  });
});
