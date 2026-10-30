import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import { auditLog } from '@openora/core/audit/schema';
import { adminInvitation, adminRole, adminRoleAssignment } from '@openora/core/iam/schema';
import {
  setupTestDb,
  bootTestApp,
  seedMinimal,
  asAdmin,
  asPlayer,
  registerPlayer,
  waitForEmail,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

const INVITEE_PASSWORD = 'invitee-chosen-passphrase';
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

let db: TestDb;
let app: TestApp;
let superAdmin: TestClient;
let roleId: string;
let superAdminId: string;

const drizzle = () => app.container.get(DRIZZLE).db;

async function invite(email: string, invitedRoleId = roleId) {
  const res = await superAdmin.post('/iam/invitations', { email, roleId: invitedRoleId });
  expect(res.status).toBe(200);
  const mail = await waitForEmail(email, (m) => UUID_PATTERN.test(m.text));
  const token = UUID_PATTERN.exec(mail.text)?.[0];
  if (!token) {
    throw new Error(`no invitation token in mail to ${email}`);
  }
  return token;
}

// Every call comes from its own address by default, so the per-address accept throttle never
// carries one test's attempts into another.
let nextAddress = 1;
const freshAddress = () => `192.0.2.${nextAddress++}`;

const accept = (body: { token: string; name: string; password: string }, ip = freshAddress()) =>
  app.app.request('/iam/invitations/accept', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': ip },
    body: JSON.stringify(body),
  });

const tokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

const invitationStatus = async (token: string) =>
  (
    await drizzle()
      .select({ status: adminInvitation.status })
      .from(adminInvitation)
      .where(eq(adminInvitation.tokenHash, tokenHash(token)))
  )[0]?.status;

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
  superAdmin = await asAdmin(app.app);
  const [role] = await drizzle().select().from(adminRole).where(eq(adminRole.key, 'admin'));
  if (!role) {
    throw new Error('no seeded admin role');
  }
  roleId = role.id;
  const [admin] = await drizzle()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, 'admin@oss.dev'));
  superAdminId = admin?.id ?? '';
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.dispose();
});

describe('admin invitation', () => {
  it('lets the invitee set a password, sign in, and hold the invited role', async () => {
    const email = `Invitee-${randomUUID()}@example.test`;
    const token = await invite(email);

    const res = await accept({ token, name: 'Invited Admin', password: INVITEE_PASSWORD });

    expect(res.status).toBe(200);
    await asAdmin(app.app, { email, password: INVITEE_PASSWORD });
    const [account] = await drizzle()
      .select({ id: user.id, role: user.role, name: user.name })
      .from(user)
      .where(eq(user.email, email.toLowerCase()));
    expect(account).toMatchObject({ role: 'admin', name: 'Invited Admin' });
    const assignments = await drizzle()
      .select({ roleId: adminRoleAssignment.roleId })
      .from(adminRoleAssignment)
      .where(eq(adminRoleAssignment.userId, account?.id ?? ''));
    expect(assignments).toEqual([{ roleId }]);
    const [invitation] = await drizzle()
      .select({ id: adminInvitation.id })
      .from(adminInvitation)
      .where(eq(adminInvitation.tokenHash, tokenHash(token)));
    await vi.waitFor(async () => {
      const rows = await drizzle()
        .select({ action: auditLog.action, actorId: auditLog.actorId })
        .from(auditLog)
        .where(eq(auditLog.resourceId, invitation?.id ?? ''));
      expect(rows).toEqual(
        expect.arrayContaining([
          { action: 'iam.invitation.created', actorId: superAdminId },
          { action: 'iam.invitation.accepted', actorId: account?.id },
        ]),
      );
    });
  });

  it('refuses a second redemption of the same token', async () => {
    const token = await invite(`replay-${randomUUID()}@example.test`);
    expect((await accept({ token, name: 'First', password: INVITEE_PASSWORD })).status).toBe(200);

    const replay = await accept({ token, name: 'Second', password: 'another-passphrase-1' });

    expect(replay.status).toBe(409);
  });

  it('refuses an email that already has an account and leaves both untouched', async () => {
    const email = `player-${randomUUID()}@example.test`;
    await registerPlayer(app, { email, password: 'player-own-password' });
    const token = await invite(email);

    const res = await accept({ token, name: 'Takeover', password: INVITEE_PASSWORD });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ data: { reason: 'email_taken' } });
    expect(await invitationStatus(token)).toBe('pending');
    await asPlayer(app.app, { email, password: 'player-own-password' });
  });

  it('rejects a password below the policy minimum', async () => {
    const token = await invite(`weak-${randomUUID()}@example.test`);

    const res = await accept({ token, name: 'Weak', password: 'short' });

    expect(res.status).toBe(400);
    expect(await invitationStatus(token)).toBe('pending');
  });

  it('lists a pending super-admin invitation without its token or token hash', async () => {
    const [superRole] = await drizzle()
      .select({ id: adminRole.id })
      .from(adminRole)
      .where(eq(adminRole.key, 'super-admin'));
    const email = `listed-${randomUUID()}@example.test`;
    const token = await invite(email, superRole?.id ?? '');

    const list = await superAdmin.get('/iam/invitations?limit=100');

    expect(list.status).toBe(200);
    const body = await list.text();
    expect(body).toContain(email);
    expect(body).not.toContain(token);
    expect(body).not.toContain(tokenHash(token));
    expect(body).not.toMatch(/"token/i);
  });

  it('refuses a sixth attempt from one address within the hour, even with the mailed token', async () => {
    const token = await invite(`throttled-${randomUUID()}@example.test`);
    const ip = freshAddress();
    for (let i = 0; i < 5; i++) {
      const guess = await accept(
        { token: randomUUID(), name: 'Guess', password: INVITEE_PASSWORD },
        ip,
      );
      expect(guess.status).toBe(409);
    }

    const sixth = await accept({ token, name: 'Late', password: INVITEE_PASSWORD }, ip);

    expect(sixth.status).toBe(429);
    expect(await invitationStatus(token)).toBe('pending');
  });
});
