import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { user, twoFactor } from '@openora/core/pam/schema/identity';
import { adminRole, adminRoleAssignment } from '@openora/core/iam/schema';
import { auditLog } from '@openora/core/audit/schema';
import {
  setupTestDb,
  bootTestApp,
  seedMinimal,
  registerAndMaterializePlayer,
  asPlayer,
  waitForEmail,
  capturedEmailsFor,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

let db: TestDb;
let app: TestApp;

const PASSWORD = 'password1234';
const RESET_PATH = '/identity/admin-security/2fa/reset-player';
const REASON = 'player lost their phone, identity checked on a call';

const drizzle = () => app.container.get(DRIZZLE).db;

async function adminWithRole(roleKey: string): Promise<TestClient> {
  const { client, userId } = await registerAndMaterializePlayer(app, {
    email: `reset-admin-${randomUUID()}@example.test`,
  });
  await drizzle().update(user).set({ role: 'admin' }).where(eq(user.id, userId));
  const [role] = await drizzle().select().from(adminRole).where(eq(adminRole.key, roleKey));
  if (!role) {
    throw new Error(`no seeded ${roleKey} role`);
  }
  await drizzle().insert(adminRoleAssignment).values({ userId, roleId: role.id });
  return client;
}

// A player who turned on "require 2FA on login" and enrolled a factor. The enrolment is
// written straight to the row: the reset under test only reads it.
async function enrolledPlayer() {
  const email = `reset-player-${randomUUID()}@example.test`;
  const { userId } = await registerAndMaterializePlayer(app, { email, password: PASSWORD });
  const client = await asPlayer(app.app, { email, password: PASSWORD });
  await drizzle()
    .update(user)
    .set({ twoFactorEnabled: true, twoFactorMethod: 'app', requireTwoFactorOnLogin: true })
    .where(eq(user.id, userId));
  await drizzle().insert(twoFactor).values({ userId, secret: 'seed-secret', backupCodes: '[]' });
  return { email, userId, client };
}

// Clearing the enrolment challenge rotates the session, so the caller has to follow the
// new cookie the way a browser would.
const followCookie = (res: Response) => {
  const cookie = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .filter(Boolean)
    .join('; ');
  return { get: async (path: string) => app.app.request(path, { headers: { cookie } }) };
};

const RESET_SUBJECT = 'Two-factor authentication was reset';
const resetNotices = (email: string) =>
  capturedEmailsFor(email).filter((m) => m.subject === RESET_SUBJECT);

const reasonOf = async (res: Response) =>
  ((await res.json()) as { data?: { reason?: string } }).data?.reason;

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('POST /identity/admin-security/2fa/reset-player', () => {
  it('refuses a caller without the player-update grant', async () => {
    const agent = await adminWithRole('customer-support-agent');
    const { userId } = await enrolledPlayer();

    const res = await agent.post(RESET_PATH, { userId, reason: REASON });

    expect(res.status).toBe(403);
    const [row] = await drizzle()
      .select({ twoFactorEnabled: user.twoFactorEnabled })
      .from(user)
      .where(eq(user.id, userId));
    expect(row?.twoFactorEnabled).toBe(true);
  });

  it('refuses a player with no second factor, without signing them out or mailing them', async () => {
    const support = await adminWithRole('support-manager');
    const email = `reset-plain-${randomUUID()}@example.test`;
    const { userId } = await registerAndMaterializePlayer(app, { email, password: PASSWORD });
    const player = await asPlayer(app.app, { email, password: PASSWORD });

    const res = await support.post(RESET_PATH, { userId, reason: REASON });

    expect(res.status).toBe(409);
    expect((await player.get('/identity/security/me')).status).toBe(200);
    expect(resetNotices(email)).toEqual([]);
  });

  it('clears the factor, audits who and why, mails once, and holds the player to re-enrolment', async () => {
    const support = await adminWithRole('support-manager');
    const { email, userId, client: oldSession } = await enrolledPlayer();

    const reset = await support.post(RESET_PATH, { userId, reason: REASON });
    expect(reset.status).toBe(200);

    const [row] = await drizzle()
      .select({
        twoFactorEnabled: user.twoFactorEnabled,
        requireTwoFactorOnLogin: user.requireTwoFactorOnLogin,
      })
      .from(user)
      .where(eq(user.id, userId));
    expect(row).toEqual({ twoFactorEnabled: false, requireTwoFactorOnLogin: true });

    await vi.waitFor(async () => {
      const audits = await drizzle()
        .select({ after: auditLog.after })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'identity.2fa.reset'),
            sql`${auditLog.after}->>'userId' = ${userId}`,
          ),
        );
      expect(audits).toEqual([{ after: expect.objectContaining({ reason: REASON }) }]);
    });

    await waitForEmail(email, (m) => m.subject === RESET_SUBJECT);
    expect((await support.post(RESET_PATH, { userId, reason: REASON })).status).toBe(409);
    expect(resetNotices(email)).toHaveLength(1);

    expect((await oldSession.get('/identity/security/me')).status).toBe(401);

    const held = await asPlayer(app.app, { email, password: PASSWORD });
    expect((await held.get('/identity/security/me')).status).toBe(200);
    expect((await held.get('/identity/2fa/status')).status).toBe(200);

    // A password-only session must not be able to switch the requirement off, take over
    // the recovery channel, or reach anything outside identity.
    const turnOff = await held.post('/identity/security/require-two-factor', { enabled: false });
    expect(turnOff.status).toBe(403);
    expect(await reasonOf(turnOff)).toBe('two_factor_setup_required');
    const emailChange = await held.post('/identity/email/change/request', {
      newEmail: `taken-over-${randomUUID()}@example.test`,
    });
    expect(emailChange.status).toBe(403);
    const balances = await held.get('/wallet/balances');
    expect(balances.status).toBe(403);
    expect(await reasonOf(balances)).toBe('two_factor_setup_required');

    // Responsible-gambling self-protection never waits on 2FA.
    expect((await held.get('/compliance/rg/me')).status).toBe(200);
    expect((await held.get('/compliance/limits')).status).toBe(200);

    const enable = await held.post('/identity/2fa/enable', { password: PASSWORD, method: 'email' });
    expect(enable.status).toBe(200);
    const mail = await waitForEmail(email, (m) => m.subject === 'Your verification code');
    const code = /(\d{6})/.exec(mail.text)?.[1];
    const verify = await held.post('/identity/2fa/verify', { code, method: 'otp' });
    expect(verify.status).toBe(200);

    const enrolled = followCookie(verify);
    await vi.waitFor(async () => {
      expect((await enrolled.get('/wallet/balances')).status).toBe(200);
    });
  });
});
