import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, seedUser as insertUser, type TestDb } from '@openora/core/testing';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import type { Auth } from '@openora/core/server';
import type { RateLimiterAdapter, SmsAdapter } from '@openora/core/contracts';
import { account, phoneVerificationSession, session, user } from '../schema/index.js';
import { PhoneVerificationService } from '../service/phone-verification.service.js';
import { makeEventBus, makeIdentityReader, mock, NO_CLIENT_META } from '../../../testing/mock.js';

const PASSWORD = 'current-password';
const PHONE = '+14155550100';

let db: TestDb;

const allowLimiter = (): RateLimiterAdapter =>
  mock<RateLimiterAdapter>({
    consume: vi.fn().mockResolvedValue({ allowed: true, retryAfterMs: 0 }),
    reset: vi.fn(),
  });

function build({ passwordMatches = true }: { passwordMatches?: boolean } = {}) {
  const events = makeEventBus();
  const sms = mock<SmsAdapter>({ sendOtp: vi.fn().mockResolvedValue(undefined) });
  const auth = mock<Auth>({
    $context: Promise.resolve({
      password: { verify: vi.fn().mockResolvedValue(passwordMatches) },
    }),
    api: { verifyTOTP: vi.fn().mockResolvedValue(new Response(null, { status: 200 })) },
  });
  const svc = new PhoneVerificationService({
    drizzle: db.drizzle,
    events,
    sms,
    limiter: allowLimiter(),
    auth,
    identityReader: makeIdentityReader(),
  });
  return { svc, events, sms };
}

async function seedAuthenticatedUser(overrides: { role?: string; email?: string } = {}) {
  const accountUser = await insertUser(db, {
    name: 'A',
    email: overrides.email ?? 'phone-verification@test.dev',
    ...(overrides.role ? { role: overrides.role } : {}),
  });
  await db.drizzle.db.insert(account).values({
    userId: accountUser.id,
    accountId: accountUser.id,
    providerId: 'credential',
    password: 'stored-password-hash',
  });
  const [activeSession] = await db.drizzle.db
    .insert(session)
    .values({
      userId: accountUser.id,
      token: 'active-session-token',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    .returning({ id: session.id });
  return { accountUser, sessionId: activeSession!.id };
}

beforeAll(async () => {
  db = await createTestDb([migrateIdentity]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${user}, ${account}, ${session}, ${phoneVerificationSession} RESTART IDENTITY CASCADE`,
  );
});

describe('PhoneVerificationService (real PG)', () => {
  it('requires the current password before it creates an OTP challenge', async () => {
    const { accountUser, sessionId } = await seedAuthenticatedUser();
    const { svc, sms } = build({ passwordMatches: false });

    await expect(
      svc.request({
        userId: accountUser.id,
        sessionId,
        input: { phone: PHONE, currentPassword: PASSWORD },
        reqHeaders: {},
        meta: NO_CLIENT_META,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(sms.sendOtp).not.toHaveBeenCalled();
    expect(await db.drizzle.db.select().from(phoneVerificationSession)).toEqual([]);
  });

  it('binds the OTP to the authenticated session, verifies the number atomically, and audits by event', async () => {
    const { accountUser, sessionId } = await seedAuthenticatedUser();
    const { svc, events, sms } = build();

    await svc.request({
      userId: accountUser.id,
      sessionId,
      input: { phone: PHONE, currentPassword: PASSWORD },
      reqHeaders: {},
      meta: NO_CLIENT_META,
    });

    const code = (sms.sendOtp as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.code;
    expect(code).toMatch(/^\d{6}$/);
    const [challenge] = await db.drizzle.db.select().from(phoneVerificationSession);
    expect(challenge).toMatchObject({
      userId: accountUser.id,
      sessionId,
      phone: PHONE,
      codeHash: createHash('sha256').update(code).digest('hex'),
    });

    const controls = await svc.confirm({
      userId: accountUser.id,
      sessionId,
      input: { code },
      meta: NO_CLIENT_META,
    });

    expect(controls).toMatchObject({ phoneNumber: PHONE, phoneVerified: true });
    const [updatedUser] = await db.drizzle.db
      .select({ phoneNumber: user.phoneNumber, phoneVerified: user.phoneVerified })
      .from(user)
      .where(eq(user.id, accountUser.id));
    expect(updatedUser).toEqual({ phoneNumber: PHONE, phoneVerified: true });
    expect(await db.drizzle.db.select().from(phoneVerificationSession)).toEqual([]);
    expect(events.emit).toHaveBeenCalledWith('identity.phone.verified', {
      userId: accountUser.id,
      playerId: null,
      previousPhoneVerified: false,
      ip: null,
      userAgent: null,
    });
    expect(events.emit).not.toHaveBeenCalledWith(
      'identity.authentication.succeeded',
      expect.anything(),
    );
  });

  it('does not allow a challenge created in another session to confirm the phone number', async () => {
    const { accountUser, sessionId } = await seedAuthenticatedUser();
    const [otherSession] = await db.drizzle.db
      .insert(session)
      .values({
        userId: accountUser.id,
        token: 'other-active-session-token',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning({ id: session.id });
    const { svc, sms } = build();

    await svc.request({
      userId: accountUser.id,
      sessionId,
      input: { phone: PHONE, currentPassword: PASSWORD },
      reqHeaders: {},
      meta: NO_CLIENT_META,
    });
    const code = (sms.sendOtp as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.code;

    await expect(
      svc.confirm({
        userId: accountUser.id,
        sessionId: otherSession!.id,
        input: { code },
        meta: NO_CLIENT_META,
      }),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE_CONTENT' });

    const [unchanged] = await db.drizzle.db
      .select({ phoneVerified: user.phoneVerified })
      .from(user)
      .where(eq(user.id, accountUser.id));
    expect(unchanged?.phoneVerified).toBe(false);
  });

  it('rejects the second confirm with CONFLICT when two accounts race to claim the same number', async () => {
    // Neither account owns PHONE yet, so `request()`'s uniqueness check (which only looks
    // at already-bound `user.phoneNumber`) lets both create a pending session for it.
    const first = await seedAuthenticatedUser();
    const second = await insertUser(db, { name: 'B', email: 'phone-verification-2@test.dev' });
    await db.drizzle.db.insert(account).values({
      userId: second.id,
      accountId: second.id,
      providerId: 'credential',
      password: 'stored-password-hash',
    });
    const [secondSession] = await db.drizzle.db
      .insert(session)
      .values({
        userId: second.id,
        token: 'second-active-session-token',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning({ id: session.id });
    const { svc, sms } = build();

    await svc.request({
      userId: first.accountUser.id,
      sessionId: first.sessionId,
      input: { phone: PHONE, currentPassword: PASSWORD },
      reqHeaders: {},
      meta: NO_CLIENT_META,
    });
    const firstCode = (sms.sendOtp as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.code;
    await svc.request({
      userId: second.id,
      sessionId: secondSession!.id,
      input: { phone: PHONE, currentPassword: PASSWORD },
      reqHeaders: {},
      meta: NO_CLIENT_META,
    });
    const secondCode = (sms.sendOtp as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]?.code;

    await svc.confirm({
      userId: first.accountUser.id,
      sessionId: first.sessionId,
      input: { code: firstCode },
      meta: NO_CLIENT_META,
    });

    await expect(
      svc.confirm({
        userId: second.id,
        sessionId: secondSession!.id,
        input: { code: secondCode },
        meta: NO_CLIENT_META,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const [unchanged] = await db.drizzle.db
      .select({ phoneNumber: user.phoneNumber, phoneVerified: user.phoneVerified })
      .from(user)
      .where(eq(user.id, second.id));
    expect(unchanged).toEqual({ phoneNumber: null, phoneVerified: false });
  });
  it('keeps counting wrong codes and burns the challenge on the last one', async () => {
    const { accountUser, sessionId } = await seedAuthenticatedUser();
    const { svc } = build();

    await svc.request({
      userId: accountUser.id,
      sessionId,
      input: { phone: PHONE, currentPassword: PASSWORD },
      reqHeaders: {},
      meta: NO_CLIENT_META,
    });

    for (let attempt = 1; attempt < 5; attempt++) {
      await expect(
        svc.confirm({
          userId: accountUser.id,
          sessionId,
          input: { code: '000000' },
          meta: NO_CLIENT_META,
        }),
      ).rejects.toMatchObject({ code: 'UNPROCESSABLE_CONTENT' });
      const [row] = await db.drizzle.db.select().from(phoneVerificationSession);
      expect(row?.failedAttempts).toBe(attempt);
    }

    await expect(
      svc.confirm({
        userId: accountUser.id,
        sessionId,
        input: { code: '000000' },
        meta: NO_CLIENT_META,
      }),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE_CONTENT' });
    expect(await db.drizzle.db.select().from(phoneVerificationSession)).toEqual([]);
  });

  it('refuses to bind a number to a non-player account', async () => {
    const { accountUser, sessionId } = await seedAuthenticatedUser({
      role: 'admin',
      email: 'phone-verification-admin@test.dev',
    });
    const { svc, sms } = build();

    await expect(
      svc.request({
        userId: accountUser.id,
        sessionId,
        input: { phone: PHONE, currentPassword: PASSWORD },
        reqHeaders: {},
        meta: NO_CLIENT_META,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(sms.sendOtp).not.toHaveBeenCalled();
    expect(await db.drizzle.db.select().from(phoneVerificationSession)).toEqual([]);
  });

  it('answers a number owned by another account without an SMS or a challenge', async () => {
    const { accountUser, sessionId } = await seedAuthenticatedUser();
    const owner = await insertUser(db, { name: 'B', email: 'phone-verification-owner@test.dev' });
    await db.drizzle.db
      .update(user)
      .set({ phoneNumber: PHONE, phoneVerified: true })
      .where(eq(user.id, owner.id));
    const { svc, sms } = build();

    const result = await svc.request({
      userId: accountUser.id,
      sessionId,
      input: { phone: PHONE, currentPassword: PASSWORD },
      reqHeaders: {},
      meta: NO_CLIENT_META,
    });

    expect(result).toMatchObject({
      expiresAt: expect.any(String),
      resendAfter: expect.any(String),
    });
    expect(sms.sendOtp).not.toHaveBeenCalled();
    expect(await db.drizzle.db.select().from(phoneVerificationSession)).toEqual([]);
  });
});
