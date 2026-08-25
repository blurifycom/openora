import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { user, session } from '@openora/core/pam/schema/identity';
import { player } from '@openora/core/pam/schema/profile';
import { auditLog } from '@openora/core/audit/schema';
import {
  verificationOtpFor,
  setupTestDb,
  bootTestApp,
  registerPlayer,
  submitRegistration,
  verifyEmailByOtp,
  capturedEmailsFor,
  seedMinimal,
  type TestDb,
  type TestApp,
} from '../index.js';

let db: TestDb;
let app: TestApp;

const login = (email: string, password = 'password123') =>
  app.app.request('/identity/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

const userIdFor = async (email: string) => {
  const [row] = await app.container
    .get(DRIZZLE)
    .db.select({ id: user.id })
    .from(user)
    .where(eq(user.email, email.toLowerCase()));
  return row?.id;
};

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('registration email verification', () => {
  it('signs the player in when the emailed code is verified', async () => {
    const email = `reg-verify-${randomUUID()}@e2e.test`;
    const res = await submitRegistration(app, { email });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'check-email' });
    // Sign-up stays sessionless - that is what keeps the duplicate-email answer
    // indistinguishable. The session is minted by verification instead.
    expect(res.headers.get('set-cookie')).toBeNull();

    const verified = await verifyEmailByOtp(app, email);
    expect(verified.headers.get('set-cookie')).toBeTruthy();
    const body = (await verified.json()) as { user: { email: string }; session: { token: string } };
    expect(body.user.email).toBe(email.toLowerCase());
    expect(body.session.token).toBeTruthy();
  });

  it('lets the verified player fill in the optional profile step with that session', async () => {
    // The modal's last screen: the session the code just minted is the only thing
    // authorising the write, so this is the whole register -> code -> profile path.
    const email = `reg-profile-${randomUUID()}@e2e.test`;
    await submitRegistration(app, { email });
    const verified = await verifyEmailByOtp(app, email);
    const cookie = (verified.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(cookie).toBeTruthy();

    const res = await app.app.request('/profile', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        firstName: 'Ada',
        lastName: 'Lovelace',
        dateOfBirth: '1990-05-17',
        phone: '+441632960001',
        country: 'GB',
      }),
    });

    expect(res.status).toBe(200);
    const [row] = await app.container
      .get(DRIZZLE)
      .db.select()
      .from(player)
      .where(eq(player.userId, (await userIdFor(email)) ?? ''));
    expect(row).toMatchObject({
      firstName: 'Ada',
      lastName: 'Lovelace',
      dateOfBirth: '1990-05-17',
      phone: '+441632960001',
      country: 'GB',
    });
  });

  it('rejects a profile update that carries no fields', async () => {
    // `Skip` must not post an empty body: without the contract's own guard this reaches
    // `db.update().set({})` and 500s.
    const email = `reg-profile-empty-${randomUUID()}@e2e.test`;
    await submitRegistration(app, { email });
    const verified = await verifyEmailByOtp(app, email);
    const cookie = (verified.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const res = await app.app.request('/profile', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it('refuses to sign in a blocked account that enters a valid code', async () => {
    // An account can be RG-blocked or suspended between registering and entering the
    // code. Verification still stands - the block is on the session, not the address.
    const email = `reg-blocked-${randomUUID()}@e2e.test`;
    await submitRegistration(app, { email });
    const otp = verificationOtpFor(email);
    const db = app.container.get(DRIZZLE).db;
    const userId = await userIdFor(email);
    await db
      .update(user)
      .set({ rgBlocked: true, rgBlockedUntil: null })
      .where(eq(user.id, userId!));

    const res = await app.app.request('/identity/email/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, otp }),
    });

    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
    const [row] = await db
      .select({ emailVerified: user.emailVerified })
      .from(user)
      .where(eq(user.id, userId!));
    expect(row?.emailVerified).toBe(true);
  });

  it('verifies but does not sign in a 2FA-enrolled account', async () => {
    // better-auth mints the post-verification session with `createSession`, which its
    // twoFactor plugin does not hook - so the code alone must not replace the second
    // factor. The address is verified; the player still signs in through /identity/login.
    const email = `reg-2fa-${randomUUID()}@e2e.test`;
    await submitRegistration(app, { email });
    const otp = verificationOtpFor(email);
    const db = app.container.get(DRIZZLE).db;
    const userId = await userIdFor(email);
    await db.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, userId!));

    const res = await app.app.request('/identity/email/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, otp }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ twoFactorRedirect: true });
    expect(res.headers.get('set-cookie')).toBeNull();
    const sessions = await db.select().from(session).where(eq(session.userId, userId!));
    expect(sessions.every((row) => row.expiresAt.getTime() <= Date.now())).toBe(true);
  });

  it('rejects a wrong code', async () => {
    const email = `reg-badotp-${randomUUID()}@e2e.test`;
    await submitRegistration(app, { email });

    const res = await app.app.request('/identity/email/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, otp: '000000' }),
    });
    expect(res.ok).toBe(false);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('lets an unverified player sign in while the verification gate is off', async () => {
    // Unverified players stay unrestricted until the operator turns the gate (or KYC)
    // on, so registering and then signing in with the password must work.
    const email = `reg-unverified-${randomUUID()}@e2e.test`;
    await submitRegistration(app, { email });

    const res = await login(email);
    expect(res.ok).toBe(true);
    expect(res.headers.get('set-cookie')).toBeTruthy();
  });

  it('hides whether the email was already taken and sends a reset instead', async () => {
    const email = `reg-enum-${randomUUID()}@e2e.test`;
    const first = await submitRegistration(app, { email });
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    const second = await submitRegistration(app, { email });
    expect(second.status).toBe(first.status);
    expect(await second.json()).toEqual(firstBody);
    expect(second.headers.get('set-cookie')).toBeNull();

    // The known-email branch must not re-provision, and must nudge the real owner
    // towards a password reset rather than confirming the address exists.
    const players = await app.container
      .get(DRIZZLE)
      .db.select()
      .from(player)
      .where(eq(player.userId, (await userIdFor(email)) ?? ''));
    expect(players).toHaveLength(1);
    // The mail must say why it arrived. A bare "Reset your password" reaches someone who
    // never asked to reset anything and explains nothing about the sign-up they just tried.
    const notice = capturedEmailsFor(email).find(
      (e) => e.subject === 'You already have an account',
    );
    expect(notice).toBeDefined();
    expect(notice?.body).toMatch(/\b\d{6}\b/);
    // Exactly one verification code was ever mailed - the one the real owner's own
    // sign-up produced. A second would hand a stranger a code that signs them in.
    expect(capturedEmailsFor(email).filter((e) => /verify/i.test(e.subject))).toHaveLength(1);
  });

  // The audit subscription is fire-and-forget, so this is the only level that proves the
  // whole chain: emit -> SUBSCRIBED_TOPICS -> mapper -> row. A unit test on the mapper
  // alone would still pass with the topic missing from the subscription list.
  it('writes a rejected attempt to the audit log with its origin and outcome', async () => {
    const email = `reg-audit-${randomUUID()}@e2e.test`;
    const username = `dup_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    await registerPlayer(app, { email: `reg-audit-first-${randomUUID()}@e2e.test`, username });

    // Called directly rather than through `submitRegistration`, which picks its own
    // client IP - the origin is what this test is about.
    const res = await app.app.request('/identity/register', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-real-ip': '203.0.113.42',
        'user-agent': 'AuditProbe/1.0',
      },
      body: JSON.stringify({
        email,
        password: 'password123',
        username: username.toUpperCase(),
        acceptedTerms: true,
        acceptedAge: true,
      }),
    });
    expect(res.status).toBe(409);

    await vi.waitFor(async () => {
      const rows = await app.container
        .get(DRIZZLE)
        .db.select()
        .from(auditLog)
        .where(eq(auditLog.action, 'identity.user.registration.failed'));
      const row = rows.find((r) => (r.after as { email?: string })?.email === email);
      expect(row).toMatchObject({
        result: 'failure',
        resourceType: 'registration',
        ip: '203.0.113.42',
        userAgent: 'AuditProbe/1.0',
      });
      expect(row?.after).toMatchObject({ reason: 'username_taken' });
    });
  });

  it('records the terms and age acceptance on the player row at registration', async () => {
    const email = `reg-consent-${randomUUID()}@e2e.test`;
    const userId = await registerPlayer(app, { email });

    const [row] = await app.container
      .get(DRIZZLE)
      .db.select()
      .from(player)
      .where(eq(player.userId, userId));

    expect(row).toBeDefined();
    expect(row?.termsVersion).toBe('test-v1');
    expect(row?.termsAcceptedAt).toBeInstanceOf(Date);
    expect(row?.ageAcceptedAt).toBeInstanceOf(Date);
    expect(row?.registrationIp).not.toBeNull();
  });

  it('rejects a username that is already taken, case-insensitively', async () => {
    const username = `dup_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    await registerPlayer(app, { email: `reg-dup-a-${randomUUID()}@e2e.test`, username });

    const res = await submitRegistration(app, {
      email: `reg-dup-b-${randomUUID()}@e2e.test`,
      username: username.toUpperCase(),
    });
    expect(res.status).toBe(409);
  });

  it('reports username availability against the case-insensitive index', async () => {
    const username = `avail_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const free = await app.app.request(`/identity/username-available?username=${username}`);
    expect(await free.json()).toEqual({ available: true });

    await registerPlayer(app, { email: `reg-avail-${randomUUID()}@e2e.test`, username });

    const taken = await app.app.request(
      `/identity/username-available?username=${username.toUpperCase()}`,
    );
    expect(await taken.json()).toEqual({ available: false });
  });
});
