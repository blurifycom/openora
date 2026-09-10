import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import {
  setupTestDb,
  bootTestApp,
  registerPlayer,
  asPlayer,
  waitForEmail,
  capturedEmailsFor,
  clearCapturedEmails,
  seedMinimal,
  type TestDb,
  type TestApp,
} from '../index.js';

let db: TestDb;
let app: TestApp;

const PASSWORD = 'password1234';

const WELCOME_SUBJECT = 'Welcome';
const CONFIRM_SUBJECT = 'Confirm your new email address';
const CHANGED_SUBJECT = 'Your email address was changed';

const newPlayer = async () => {
  const email = `mail-lc-${randomUUID()}@e2e.test`;
  const userId = await registerPlayer(app, { email, password: PASSWORD });
  return { email, userId, client: await asPlayer(app.app, { email, password: PASSWORD }) };
};

const emailOf = async (userId: string): Promise<string> => {
  const [row] = await app.container
    .get(DRIZZLE)
    .db.select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId));
  return row!.email;
};

const codeFrom = async (address: string, subject: string): Promise<string> => {
  const mail = await waitForEmail(address, (m) => m.subject === subject);
  const code = /(\d{6})/.exec(mail.text)?.[1];
  if (!code) {
    throw new Error(`no 6-digit code in "${subject}" mail: ${mail.text}`);
  }
  return code;
};

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

describe('welcome mail', () => {
  it('goes out once the registration code is verified', async () => {
    clearCapturedEmails();
    const email = `welcome-${randomUUID()}@e2e.test`;

    await registerPlayer(app, { email, password: PASSWORD });

    await waitForEmail(email, (m) => m.subject === WELCOME_SUBJECT);
  });
});

describe('email change flow', () => {
  it('confirms the new address with an OTP and notifies the old one', async () => {
    const { userId, email: oldEmail, client } = await newPlayer();
    const newEmail = `mail-lc-new-${randomUUID()}@e2e.test`;
    clearCapturedEmails();

    const requested = await client.post('/identity/email/change/request', { newEmail });
    expect(requested.status).toBe(200);

    const otp = await codeFrom(newEmail, CONFIRM_SUBJECT);
    const confirmed = await client.post('/identity/email/change/confirm', { newEmail, otp });
    expect(confirmed.status).toBe(200);

    expect(await emailOf(userId)).toBe(newEmail);

    // "It changed" notice lands on the OLD inbox, not the new one.
    const notice = await waitForEmail(oldEmail, (m) => m.subject === CHANGED_SUBJECT);
    expect(notice.text).toContain(newEmail);
    expect(capturedEmailsFor(newEmail).some((m) => m.subject === CHANGED_SUBJECT)).toBe(false);

    // No second welcome for an account that already had one.
    expect(capturedEmailsFor(newEmail).some((m) => m.subject === WELCOME_SUBJECT)).toBe(false);
  });

  it('rejects a wrong confirmation code and leaves the address untouched', async () => {
    const { userId, email: oldEmail, client } = await newPlayer();
    const newEmail = `mail-lc-wrong-${randomUUID()}@e2e.test`;

    await client.post('/identity/email/change/request', { newEmail });
    const bad = await client.post('/identity/email/change/confirm', { newEmail, otp: '000000' });

    expect(bad.status).toBe(400);
    expect(await emailOf(userId)).toBe(oldEmail);
  });

  it('rejects a confirmation code that was already spent', async () => {
    const { client } = await newPlayer();
    const newEmail = `mail-lc-replay-${randomUUID()}@e2e.test`;
    clearCapturedEmails();

    await client.post('/identity/email/change/request', { newEmail });
    const otp = await codeFrom(newEmail, CONFIRM_SUBJECT);

    expect((await client.post('/identity/email/change/confirm', { newEmail, otp })).status).toBe(
      200,
    );
    const replay = await client.post('/identity/email/change/confirm', { newEmail, otp });
    expect(replay.ok).toBe(false);
  });

  it('cannot be pointed at an address another account already owns', async () => {
    const { email: takenEmail } = await newPlayer();
    const { userId, email: oldEmail, client } = await newPlayer();
    clearCapturedEmails();

    // Anti-enumeration: the request still answers 200, but no code is sent and the
    // confirm step has nothing to verify against.
    const requested = await client.post('/identity/email/change/request', {
      newEmail: takenEmail,
    });
    expect(requested.status).toBe(200);
    expect(capturedEmailsFor(takenEmail).some((m) => m.subject === CONFIRM_SUBJECT)).toBe(false);

    const confirmed = await client.post('/identity/email/change/confirm', {
      newEmail: takenEmail,
      otp: '123456',
    });
    expect(confirmed.ok).toBe(false);
    expect(await emailOf(userId)).toBe(oldEmail);
  });
});
