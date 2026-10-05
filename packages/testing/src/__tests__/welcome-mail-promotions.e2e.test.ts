import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { countryRule } from '@openora/core/compliance/schema';
import { user } from '@openora/core/pam/schema/identity';
import {
  bootTestApp,
  registerPlayer,
  seedMinimal,
  setupTestDb,
  submitRegistration,
  verificationOtpFor,
  waitForEmail,
  type TestApp,
  type TestDb,
} from '../index.js';
import {
  WELCOME_BLOCKED_COUNTRY_IP,
  holdNextEligibleWelcome,
} from './fixtures/test-welcome-promotions-plugin.js';

let db: TestDb;
let app: TestApp;

const welcomeTextFor = async (email: string) =>
  (await waitForEmail(email, (m) => m.subject === 'Welcome')).text;

const registerUnverified = async () => {
  const email = `welcome-promo-${randomUUID()}@e2e.test`;
  const res = await submitRegistration(app, { email });
  expect(res.ok).toBe(true);
  const [row] = await app.container
    .get(DRIZZLE)
    .db.select({ id: user.id })
    .from(user)
    .where(eq(user.email, email));
  return { email, userId: row!.id };
};

// The gates below refuse the session, not the verification, so the welcome mail still goes.
const verifyFrom = async (email: string, ip: string) =>
  app.app.request('/identity/email/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': ip },
    body: JSON.stringify({ email, otp: await verificationOtpFor(email) }),
  });

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({
    plugins: [
      ...(await loadExtensions()),
      {
        id: 'test-welcome-promotions',
        path: fileURLToPath(
          new URL('./fixtures/test-welcome-promotions-plugin.ts', import.meta.url),
        ),
      },
    ],
    databaseUrl: db.url,
  });
  await seedMinimal(app.container, { playerCount: 0 });
  await app.container
    .get(DRIZZLE)
    .db.insert(countryRule)
    .values({ countryCode: 'DE', action: 'block' })
    .onConflictDoUpdate({ target: countryRule.countryCode, set: { action: 'block' } });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('welcome mail promotion eligibility', () => {
  it('marks a player in good standing from an allowed country as eligible', async () => {
    const email = `welcome-promo-${randomUUID()}@e2e.test`;
    await registerPlayer(app, { email });

    expect(await welcomeTextFor(email)).toContain('promotionsEligible=true');
  });

  it('withholds the promotion from an account RG-blocked before it verified', async () => {
    const { email, userId } = await registerUnverified();
    await app.container
      .get(DRIZZLE)
      .db.update(user)
      .set({ rgBlocked: true, rgBlockedUntil: null })
      .where(eq(user.id, userId));

    await verifyFrom(email, '198.18.250.1');

    expect(await welcomeTextFor(email)).toContain('promotionsEligible=false');
  });

  it('rechecks the restriction when a queued eligible welcome is retried', async () => {
    const held = holdNextEligibleWelcome();
    const { email, userId } = await registerUnverified();

    await verifyFrom(email, '198.18.250.3');
    await held.reached;
    await app.container
      .get(DRIZZLE)
      .db.update(user)
      .set({ rgBlocked: true, rgBlockedUntil: null })
      .where(eq(user.id, userId));
    held.release();

    expect(await welcomeTextFor(email)).toContain('promotionsEligible=false');
  });

  it('withholds the promotion from a player verifying from a blocked country', async () => {
    const { email } = await registerUnverified();

    await verifyFrom(email, WELCOME_BLOCKED_COUNTRY_IP);

    expect(await welcomeTextFor(email)).toContain('promotionsEligible=false');
  });
});
