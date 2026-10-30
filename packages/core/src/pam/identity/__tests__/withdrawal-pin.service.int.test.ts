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
import {
  SetWithdrawalPinInputSchema,
  type MailDispatchPort,
  type RateLimiterAdapter,
} from '@openora/core/contracts';
import { account, user } from '../schema/index.js';
import { WithdrawalPinService } from '../service/withdrawal-pin.service.js';
import { makeEventBus, makeIdentityReader, mock, NO_CLIENT_META } from '../../../testing/mock.js';

const PASSWORD = 'current-password';
const HMAC_SECRET = 'a'.repeat(32);
const PIN = '1234';
const WRONG_PIN = '9999';
const REMOVE_PROOF = { currentPassword: PASSWORD };

let db: TestDb;

const allowLimiter = (): RateLimiterAdapter =>
  mock<RateLimiterAdapter>({
    consume: vi.fn().mockResolvedValue({ allowed: true, retryAfterMs: 0 }),
    reset: vi.fn(),
  });

function build({
  passwordMatches = true,
  limiter,
  mailDispatch,
}: {
  passwordMatches?: boolean;
  limiter?: RateLimiterAdapter;
  mailDispatch?: MailDispatchPort;
} = {}) {
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
    mailDispatch,
    hmacSecret: HMAC_SECRET,
    trustedDeviceDays: 30,
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

  it('removes an existing PIN after reauthentication and audits by event', async () => {
    const accountUser = await seedAuthenticatedUser();
    const { svc, events } = build();
    await svc.set(
      accountUser.id,
      { pin: PIN, confirmPin: PIN, currentPassword: PASSWORD },
      {},
      NO_CLIENT_META,
    );

    const controls = await svc.remove(accountUser.id, REMOVE_PROOF, {}, NO_CLIENT_META);

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

    const controls = await svc.remove(accountUser.id, REMOVE_PROOF, {}, NO_CLIENT_META);

    expect(controls.withdrawalPinSet).toBe(false);
    expect(events.emit).not.toHaveBeenCalledWith(
      'identity.security.withdrawal_pin.removed',
      expect.anything(),
    );
  });
});

describe('WithdrawalPinService - removal needs the same proof as setting (real PG)', () => {
  it('refuses a wrong password and keeps the PIN', async () => {
    const accountUser = await seedAuthenticatedUser();
    await build().svc.set(
      accountUser.id,
      { pin: PIN, confirmPin: PIN, currentPassword: PASSWORD },
      {},
      NO_CLIENT_META,
    );
    const { svc, events } = build({ passwordMatches: false });

    await expect(
      svc.remove(accountUser.id, { currentPassword: 'wrong-password' }, {}, NO_CLIENT_META),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect((await readUser(accountUser.id))?.withdrawalPinHash).not.toBeNull();
    expect(events.emit).not.toHaveBeenCalledWith(
      'identity.security.withdrawal_pin.removed',
      expect.anything(),
    );
  });

  it('asks for the 2FA code when the account has 2FA, and refuses without it', async () => {
    const accountUser = await seedAuthenticatedUser({ twoFactorEnabled: true });
    await build()
      .svc.set(
        accountUser.id,
        { pin: PIN, confirmPin: PIN, currentPassword: PASSWORD, totpCode: '123456' },
        {},
        NO_CLIENT_META,
      )
      .catch(() => undefined);
    await db.drizzle.db
      .update(user)
      .set({ withdrawalPinHash: 'x'.repeat(64) })
      .where(eq(user.id, accountUser.id));
    const { svc } = build();

    await expect(
      svc.remove(accountUser.id, REMOVE_PROOF, {}, NO_CLIENT_META),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE_CONTENT' });

    expect((await readUser(accountUser.id))?.withdrawalPinHash).not.toBeNull();
  });

  it('refuses a wrong password even when no PIN is set, so the answer does not leak whether one is', async () => {
    const accountUser = await seedAuthenticatedUser();
    const { svc } = build({ passwordMatches: false });

    await expect(
      svc.remove(accountUser.id, { currentPassword: 'wrong-password' }, {}, NO_CLIENT_META),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('WithdrawalPinService.verifyPin (real PG)', () => {
  async function withPin(opts: Parameters<typeof build>[0] = {}) {
    const accountUser = await seedAuthenticatedUser();
    const harness = build(opts);
    await harness.svc.set(
      accountUser.id,
      { pin: PIN, confirmPin: PIN, currentPassword: PASSWORD },
      {},
      NO_CLIENT_META,
    );
    return { accountUser, ...harness };
  }

  it('answers not_set for an account without a PIN', async () => {
    const accountUser = await seedAuthenticatedUser();
    const { svc } = build();

    await expect(svc.verifyPin({ userId: accountUser.id, pin: PIN })).resolves.toEqual({
      status: 'not_set',
    });
  });

  it('answers missing when a PIN is set and none is sent, without counting a failure', async () => {
    const { accountUser, svc } = await withPin();

    await expect(svc.verifyPin({ userId: accountUser.id, pin: undefined })).resolves.toEqual({
      status: 'missing',
    });
    expect((await readUser(accountUser.id))?.withdrawalPinFailedAttempts).toBe(0);
  });

  it('accepts the right PIN', async () => {
    const { accountUser, svc } = await withPin();

    await expect(svc.verifyPin({ userId: accountUser.id, pin: PIN })).resolves.toEqual({
      status: 'ok',
    });
  });

  it('counts wrong PINs down from 5 and tells the caller how many are left', async () => {
    const { accountUser, svc } = await withPin();

    for (const attemptsLeft of [4, 3, 2, 1]) {
      await expect(svc.verifyPin({ userId: accountUser.id, pin: WRONG_PIN })).resolves.toEqual({
        status: 'incorrect',
        attemptsLeft,
      });
    }
  });

  it('locks on the 5th wrong PIN, emits the lock event and mails the player once', async () => {
    const toUser = vi.fn(async () => undefined);
    const { accountUser, svc, events } = await withPin({
      mailDispatch: { toUser, toAddress: vi.fn() },
    });

    for (let i = 0; i < 4; i++) {
      await svc.verifyPin({ userId: accountUser.id, pin: WRONG_PIN });
    }
    const fifth = await svc.verifyPin({ userId: accountUser.id, pin: WRONG_PIN });

    expect(fifth.status).toBe('locked');
    const lockedUntil = (fifth as { lockedUntil: Date }).lockedUntil.getTime();
    expect(lockedUntil - Date.now()).toBeGreaterThan(29 * 60 * 1000);
    expect(lockedUntil - Date.now()).toBeLessThanOrEqual(30 * 60 * 1000);
    expect(events.emit).toHaveBeenCalledWith(
      'identity.security.withdrawal_pin.locked',
      expect.objectContaining({ userId: accountUser.id }),
    );
    expect(toUser).toHaveBeenCalledTimes(1);
    expect(toUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: accountUser.id,
        template: { key: 'withdrawalsLocked', data: expect.any(Object) },
      }),
    );
  });

  it('keeps refusing during the lock, even for the right PIN, and does not mail again', async () => {
    const toUser = vi.fn(async () => undefined);
    const { accountUser, svc } = await withPin({ mailDispatch: { toUser, toAddress: vi.fn() } });
    for (let i = 0; i < 5; i++) {
      await svc.verifyPin({ userId: accountUser.id, pin: WRONG_PIN });
    }

    await expect(svc.verifyPin({ userId: accountUser.id, pin: PIN })).resolves.toMatchObject({
      status: 'locked',
    });
    await expect(svc.verifyPin({ userId: accountUser.id, pin: WRONG_PIN })).resolves.toMatchObject({
      status: 'locked',
    });
    expect(toUser).toHaveBeenCalledTimes(1);
  });

  it('accepts the PIN again once the lock has run out, and starts a fresh count', async () => {
    const { accountUser, svc } = await withPin();
    for (let i = 0; i < 5; i++) {
      await svc.verifyPin({ userId: accountUser.id, pin: WRONG_PIN });
    }
    await db.drizzle.db
      .update(user)
      .set({ withdrawalPinLockedUntil: new Date(Date.now() - 1000) })
      .where(eq(user.id, accountUser.id));

    await expect(svc.verifyPin({ userId: accountUser.id, pin: WRONG_PIN })).resolves.toEqual({
      status: 'incorrect',
      attemptsLeft: 4,
    });
    await expect(svc.verifyPin({ userId: accountUser.id, pin: PIN })).resolves.toEqual({
      status: 'ok',
    });
  });

  it('resets the count on a right PIN, so the wrong ones must be in a row', async () => {
    const { accountUser, svc } = await withPin();
    for (let i = 0; i < 4; i++) {
      await svc.verifyPin({ userId: accountUser.id, pin: WRONG_PIN });
    }
    await svc.verifyPin({ userId: accountUser.id, pin: PIN });

    await expect(svc.verifyPin({ userId: accountUser.id, pin: WRONG_PIN })).resolves.toEqual({
      status: 'incorrect',
      attemptsLeft: 4,
    });
  });

  it('counts every guess of a parallel burst, so it cannot walk past the limit', async () => {
    const { accountUser, svc } = await withPin();

    const verdicts = await Promise.all(
      Array.from({ length: 5 }, () => svc.verifyPin({ userId: accountUser.id, pin: WRONG_PIN })),
    );

    expect(verdicts.filter((v) => v.status === 'locked')).toHaveLength(1);
    await expect(svc.verifyPin({ userId: accountUser.id, pin: PIN })).resolves.toMatchObject({
      status: 'locked',
    });
  });

  it('a failed mail enqueue does not turn the lock into an error', async () => {
    const toUser = vi.fn(async () => {
      throw new Error('queue down');
    });
    const { accountUser, svc } = await withPin({ mailDispatch: { toUser, toAddress: vi.fn() } });

    for (let i = 0; i < 4; i++) {
      await svc.verifyPin({ userId: accountUser.id, pin: WRONG_PIN });
    }

    await expect(svc.verifyPin({ userId: accountUser.id, pin: WRONG_PIN })).resolves.toMatchObject({
      status: 'locked',
    });
  });
});

describe('WithdrawalPinService.assertReauthentication (real PG)', () => {
  it('refuses a wrong password', async () => {
    const accountUser = await seedAuthenticatedUser();
    const { svc } = build({ passwordMatches: false });

    await expect(
      svc.assertReauthentication({
        userId: accountUser.id,
        headers: {},
        currentPassword: 'wrong-password',
        totpCode: undefined,
        meta: NO_CLIENT_META,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('stops a password guesser after 10 tries in the window', async () => {
    const accountUser = await seedAuthenticatedUser();
    const limiter = mock<RateLimiterAdapter>({
      consume: vi
        .fn()
        .mockResolvedValueOnce({ allowed: true, retryAfterMs: 0 })
        .mockResolvedValue({ allowed: false, retryAfterMs: 1000 }),
      reset: vi.fn(),
    });
    const { svc } = build({ passwordMatches: false, limiter });
    const attempt = () =>
      svc.assertReauthentication({
        userId: accountUser.id,
        headers: {},
        currentPassword: 'wrong-password',
        totpCode: undefined,
        meta: NO_CLIENT_META,
      });

    await expect(attempt()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(attempt()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
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
      await svc.remove(accountUser.id, REMOVE_PROOF, {}, NO_CLIENT_META);
    }

    await expect(
      svc.remove(accountUser.id, REMOVE_PROOF, {}, NO_CLIENT_META),
    ).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
  });
});
