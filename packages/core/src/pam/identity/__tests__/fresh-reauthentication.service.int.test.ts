import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, seedUser, type TestDb } from '@openora/core/testing';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import type { Auth } from '@openora/core/server';
import { AdminSecurityConfigSchema } from '@openora/core/contracts';
import { account, user } from '../schema/index.js';
import { FreshReauthenticationService } from '../service/fresh-reauthentication.service.js';
import { TwoFactorLockoutService } from '../service/two-factor-lockout.service.js';
import { makeEventBus, makeIdentityReader, mock } from '../../../testing/mock.js';

const PASSWORD = 'current-password';
const CODE = '123456';
const META = { ip: '203.0.113.7', userAgent: 'backoffice/1.0' };
const HEADERS = { cookie: 'session=abc', 'user-agent': 'backoffice/1.0' };
const LOCKOUT = AdminSecurityConfigSchema.parse({}).twoFactorLockout;

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrateIdentity]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${user}, ${account} RESTART IDENTITY CASCADE`);
});

const answer = (status: number) =>
  vi.fn(async (_opts: { headers: Headers }) => new Response(null, { status }));

function build({ codeStatus = 200 }: { codeStatus?: number } = {}) {
  const events = makeEventBus();
  const verifyPassword = vi.fn(
    async ({ password }: { password: string; hash: string }) => password === PASSWORD,
  );
  const api = {
    verifyTOTP: answer(codeStatus),
    verifyTwoFactorOTP: answer(codeStatus),
    verifyBackupCode: answer(codeStatus),
  };
  const auth = mock<Auth>({
    $context: Promise.resolve({ password: { verify: verifyPassword } }),
    api,
  });
  const svc = new FreshReauthenticationService({
    drizzle: db.drizzle,
    auth,
    twoFactorLockout: new TwoFactorLockoutService({
      drizzle: db.drizzle,
      events,
      identityReader: makeIdentityReader(),
      config: LOCKOUT,
    }),
  });
  return { svc, events, verifyPassword, api };
}

async function seedAccount(over: Partial<typeof user.$inferInsert> = {}) {
  const owner = await seedUser(db, { email: `reauth-${randomUUID()}@ops.example`, ...over });
  await db.drizzle.db.insert(account).values({
    userId: owner.id,
    accountId: owner.id,
    providerId: 'credential',
    password: 'stored-password-hash',
  });
  return owner;
}

async function twoFactorState(userId: string) {
  const [row] = await db.drizzle.db
    .select({
      failedAttempts: user.failedTwoFactorAttempts,
      lockoutUntil: user.twoFactorLockoutUntil,
    })
    .from(user)
    .where(eq(user.id, userId));
  return row;
}

const assertAs = (
  svc: FreshReauthenticationService,
  userId: string,
  proof: { currentPassword?: string; totpCode?: string } = {},
) =>
  svc.assert({
    userId,
    headers: HEADERS,
    currentPassword: proof.currentPassword ?? PASSWORD,
    totpCode: proof.totpCode,
    meta: META,
  });

describe('FreshReauthenticationService.assert (real PG)', () => {
  it('passes the right password on an account without a second factor', async () => {
    const { svc, api } = build();
    const owner = await seedAccount();

    expect(await assertAs(svc, owner.id)).toEqual({ status: 'ok' });
    expect(api.verifyTOTP).not.toHaveBeenCalled();
  });

  it('refuses a wrong password without counting a second-factor failure', async () => {
    const { svc, events } = build();
    const owner = await seedAccount({ twoFactorEnabled: true });

    expect(await assertAs(svc, owner.id, { currentPassword: 'wrong', totpCode: CODE })).toEqual({
      status: 'password_invalid',
    });
    expect(await twoFactorState(owner.id)).toMatchObject({ failedAttempts: 0 });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('refuses an account with no password credential, and an unknown account', async () => {
    const { svc } = build();
    const passwordless = await seedUser(db, { email: `reauth-${randomUUID()}@ops.example` });

    expect(await assertAs(svc, passwordless.id)).toEqual({ status: 'password_invalid' });
    expect(await assertAs(svc, randomUUID())).toEqual({ status: 'password_invalid' });
  });

  it('asks for the second factor when one is enrolled and no code came', async () => {
    const { svc, api } = build();
    const owner = await seedAccount({ twoFactorEnabled: true });

    expect(await assertAs(svc, owner.id)).toEqual({ status: 'second_factor_required' });
    expect(api.verifyTOTP).not.toHaveBeenCalled();
  });

  it('answers a locked account as locked whatever the password, before checking it', async () => {
    const { svc, verifyPassword } = build();
    const lockedUntil = new Date(Date.now() + 10 * 60 * 1000);
    const owner = await seedAccount({ twoFactorEnabled: true, twoFactorLockoutUntil: lockedUntil });

    for (const currentPassword of [PASSWORD, 'wrong']) {
      expect(await assertAs(svc, owner.id, { currentPassword, totpCode: CODE })).toEqual({
        status: 'locked',
        lockedUntil,
      });
    }
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('checks the code against the caller session and resets the failure count when it is right', async () => {
    const { svc, api } = build();
    const owner = await seedAccount({ twoFactorEnabled: true, failedTwoFactorAttempts: 2 });

    expect(await assertAs(svc, owner.id, { totpCode: CODE })).toEqual({ status: 'ok' });

    expect(api.verifyTOTP).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ body: { code: CODE, trustDevice: false } }),
    );
    expect(api.verifyTOTP.mock.calls[0]?.[0].headers.get('cookie')).toBe(HEADERS.cookie);
    expect(await twoFactorState(owner.id)).toMatchObject({ failedAttempts: 0, lockoutUntil: null });
  });

  it('verifies a pushed code for an account that receives its codes by email', async () => {
    const { svc, api } = build();
    const owner = await seedAccount({ twoFactorEnabled: true, twoFactorMethod: 'email' });

    expect(await assertAs(svc, owner.id, { totpCode: CODE })).toEqual({ status: 'ok' });
    expect(api.verifyTwoFactorOTP).toHaveBeenCalledOnce();
    expect(api.verifyTOTP).not.toHaveBeenCalled();
  });

  it('counts a wrong code toward the lockout and says how many attempts are left', async () => {
    const { svc, events } = build({ codeStatus: 401 });
    const owner = await seedAccount({ twoFactorEnabled: true });

    expect(await assertAs(svc, owner.id, { totpCode: CODE })).toEqual({
      status: 'second_factor_invalid',
      attemptsLeft: LOCKOUT.maxAttempts - 1,
    });
    expect(await twoFactorState(owner.id)).toMatchObject({ failedAttempts: 1 });
    expect(events.emit).toHaveBeenCalledWith(
      'identity.2fa.failed',
      expect.objectContaining({
        userId: owner.id,
        method: 'totp',
        attemptsRemaining: LOCKOUT.maxAttempts - 1,
        ...META,
      }),
    );
  });

  it('locks the second factor on the last allowed wrong code and answers locked', async () => {
    const { svc, events } = build({ codeStatus: 401 });
    const owner = await seedAccount({
      twoFactorEnabled: true,
      failedTwoFactorAttempts: LOCKOUT.maxAttempts - 1,
    });

    const verdict = await assertAs(svc, owner.id, { totpCode: CODE });

    const { lockoutUntil } = (await twoFactorState(owner.id)) ?? {};
    expect(lockoutUntil).toBeInstanceOf(Date);
    expect(verdict).toEqual({ status: 'locked', lockedUntil: lockoutUntil });
    expect(events.emit).toHaveBeenCalledWith(
      'identity.2fa.lockout.triggered',
      expect.objectContaining({ userId: owner.id }),
    );
  });

  it('counts each wrong code of an overlapping burst and locks once', async () => {
    const { svc, events } = build({ codeStatus: 401 });
    const owner = await seedAccount({ twoFactorEnabled: true });

    const verdicts = await Promise.all(
      Array.from({ length: 12 }, () => assertAs(svc, owner.id, { totpCode: CODE })),
    );

    expect(verdicts.filter((v) => v.status === 'second_factor_invalid')).toHaveLength(
      LOCKOUT.maxAttempts - 1,
    );
    expect(verdicts.filter((v) => v.status === 'locked')).toHaveLength(
      12 - (LOCKOUT.maxAttempts - 1),
    );
    const locks = events.emit.mock.calls.filter(
      ([topic]) => topic === 'identity.2fa.lockout.triggered',
    );
    expect(locks).toHaveLength(1);
    const [row] = await db.drizzle.db
      .select({ lockoutCount: user.twoFactorLockoutCount })
      .from(user)
      .where(eq(user.id, owner.id));
    expect(row?.lockoutCount).toBe(1);
  });
});
