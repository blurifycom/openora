import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import {
  setupTestDb,
  bootTestApp,
  registerPlayer,
  asPlayer,
  waitForEmail,
  clearCapturedEmails,
  seedMinimal,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

/**
 * RFC 4648 base32 decode (no padding) - just enough to turn the `secret` query
 * param of an `otpauth://` URI back into the raw bytes better-auth signed with.
 */
function decodeBase32(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of input.toUpperCase().replace(/=+$/, '')) {
    const value = alphabet.indexOf(char);
    if (value === -1) {
      throw new Error(`invalid base32 character: ${char}`);
    }
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/**
 * RFC 6238 TOTP, 30s step / 6 digits / SHA-1 - the defaults `otpOptions` in
 * `server/auth/auth.ts` leaves unconfigured, matching what better-auth itself
 * verifies. Computed straight from the secret rather than pulling in an OTP
 * library, since this is the only place in the test suite that needs one.
 */
function totpCode(base32Secret: string, atMs = Date.now()): string {
  const key = decodeBase32(base32Secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 1000 / 30)));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const truncated =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(truncated % 1_000_000).padStart(6, '0');
}

function secretFromTotpUri(totpUri: string): string {
  const secret = new URL(totpUri.replace('otpauth://', 'http://')).searchParams.get('secret');
  if (!secret) {
    throw new Error(`no secret in totpUri: ${totpUri}`);
  }
  return secret;
}

const smsFailurePluginPath = fileURLToPath(
  new URL('../test-sms-failure-plugin.ts', import.meta.url),
);

let db: TestDb;
let app: TestApp;

const PASSWORD = 'password1234';

const newPlayer = async (): Promise<{ email: string; userId: string; client: TestClient }> => {
  const email = `2fa-${randomUUID()}@e2e.test`;
  const userId = await registerPlayer(app, { email, password: PASSWORD });
  return { email, userId, client: await asPlayer(app.app, { email, password: PASSWORD }) };
};

const codeFromEmail = async (email: string): Promise<string> => {
  const mail = await waitForEmail(email, (m) => m.subject === 'Your verification code');
  const match = /(\d{6})/.exec(mail.text);
  if (!match?.[1]) {
    throw new Error(`no 6-digit code in mail: ${mail.text}`);
  }
  return match[1];
};

/**
 * Clearing a challenge rotates the session, so the cookie the caller signed in with
 * is dead the moment the second factor is accepted. Tests have to follow the new one
 * the way a browser would.
 */
const followCookie = (res: Response) => {
  const cookie = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .filter(Boolean)
    .join('; ');
  return {
    get: (path: string) => app.app.request(path, { headers: { cookie } }),
    post: (path: string, body?: unknown) =>
      app.app.request(path, {
        method: 'POST',
        ...(body === undefined
          ? { headers: { cookie } }
          : {
              headers: { cookie, 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
      }),
  };
};

const setPhone = (userId: string, phoneNumber: string | null, phoneVerified: boolean) =>
  app.container
    .get(DRIZZLE)
    .db.update(user)
    .set({ phoneNumber, phoneVerified })
    .where(eq(user.id, userId));

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

describe('GET /identity/2fa/status', () => {
  it('reports no active method before enrolment, and masks the destinations', async () => {
    const { email, client } = await newPlayer();

    const res = await client.get('/identity/2fa/status');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enabled: boolean;
      method: string | null;
      maskedEmail: string;
      maskedPhone: string | null;
    };
    expect(body.enabled).toBe(false);
    expect(body.method).toBeNull();
    expect(body.maskedPhone).toBeNull();
    // The masked address identifies which of your own addresses a code goes to
    // without handing the whole address to a half-authenticated caller.
    expect(body.maskedEmail).toBe(`${email[0]}***@e2e.test`);
    expect(body.maskedEmail).not.toBe(email);
  });

  it('refuses an anonymous caller', async () => {
    const res = await app.app.request('/identity/2fa/status');
    expect(res.status).toBe(401);
  });
});

describe('POST /identity/2fa/otp/send', () => {
  it('refuses an anonymous caller with neither a session nor a pending challenge', async () => {
    const res = await app.app.request('/identity/2fa/otp/send', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('refuses an account that reads its codes off an authenticator', async () => {
    const { client } = await newPlayer();
    const enable = await client.post('/identity/2fa/enable', { password: PASSWORD, method: 'app' });
    expect(enable.status).toBe(200);

    const res = await client.post('/identity/2fa/otp/send');

    expect(res.status).toBe(400);
  });
});

describe('two-factor enrolment by email', () => {
  it('pushes a code on enrolment and activates the method once that code clears', async () => {
    clearCapturedEmails();
    const { email, userId, client } = await newPlayer();

    const enable = await client.post('/identity/2fa/enable', {
      password: PASSWORD,
      method: 'email',
    });

    expect(enable.status).toBe(200);
    const enrolment = (await enable.json()) as {
      totpUri?: string;
      backupCodes: string[];
      maskedDestination?: string;
    };
    // Nothing to scan on a pushed method, so no URI is minted for the client.
    expect(enrolment.totpUri).toBeUndefined();
    expect(enrolment.maskedDestination).toBe(`${email[0]}***@e2e.test`);
    expect(enrolment.backupCodes.length).toBeGreaterThan(0);

    // Not live until the first code clears.
    const midway = (await (await client.get('/identity/2fa/status')).json()) as {
      enabled: boolean;
      method: string | null;
    };
    expect(midway.enabled).toBe(false);
    expect(midway.method).toBeNull();

    const verify = await client.post('/identity/2fa/verify', {
      code: await codeFromEmail(email),
      method: 'otp',
    });
    expect(verify.status).toBe(200);

    const after = (await (await followCookie(verify).get('/identity/2fa/status')).json()) as {
      enabled: boolean;
      method: string | null;
    };
    expect(after).toMatchObject({ enabled: true, method: 'email' });
    const [row] = await app.container
      .get(DRIZZLE)
      .db.select({ method: user.twoFactorMethod })
      .from(user)
      .where(eq(user.id, userId));
    expect(row?.method).toBe('email');
  });

  it('resends a different code to the same address', async () => {
    clearCapturedEmails();
    const { email, client } = await newPlayer();
    await client.post('/identity/2fa/enable', { password: PASSWORD, method: 'email' });
    const first = await codeFromEmail(email);

    clearCapturedEmails();
    const resend = await client.post('/identity/2fa/otp/send');

    expect(resend.status).toBe(200);
    expect(await resend.json()).toEqual({ maskedDestination: `${email[0]}***@e2e.test` });
    const second = await codeFromEmail(email);
    expect(second).not.toBe(first);
  });

  it('never stores the delivered code in a form the database can be read for', async () => {
    clearCapturedEmails();
    const { email, client } = await newPlayer();
    await client.post('/identity/2fa/enable', { password: PASSWORD, method: 'email' });
    const code = await codeFromEmail(email);

    const result = await app.container
      .get(DRIZZLE)
      .db.execute(`SELECT value FROM verification WHERE identifier LIKE '2fa-otp-%'`);
    const stored = (result.rows as { value: unknown }[]).map((r) => String(r.value));

    expect(stored.length).toBeGreaterThan(0);
    // Read access to `verification` plus the password must not be a full account
    // takeover: the stored value is a hash, not the code that was mailed.
    expect(stored.some((value) => value.startsWith(`${code}:`))).toBe(false);
  });

  it('refuses to re-enrol an account that already has a live second factor', async () => {
    clearCapturedEmails();
    const { email, client } = await newPlayer();
    await client.post('/identity/2fa/enable', { password: PASSWORD, method: 'email' });
    const verify = await client.post('/identity/2fa/verify', {
      code: await codeFromEmail(email),
      method: 'otp',
    });
    const live = followCookie(verify);

    const again = await live.post('/identity/2fa/enable', {
      password: PASSWORD,
      method: 'app',
    });

    // Enrolling again would mint a fresh secret and fresh backup codes on the spot,
    // so the working second factor must survive the attempt untouched.
    expect(again.status).toBe(409);
    const after = (await (await live.get('/identity/2fa/status')).json()) as {
      enabled: boolean;
      method: string | null;
    };
    expect(after).toMatchObject({ enabled: true, method: 'email' });
  });
});

describe('two-factor enrolment gates', () => {
  it('refuses sms without a verified phone number', async () => {
    const { userId, client } = await newPlayer();
    // `user.phoneNumber` is unique, so the number has to be unique per test run.
    await setPhone(userId, `+1555${String(Date.now()).slice(-7)}`, false);

    const res = await client.post('/identity/2fa/enable', { password: PASSWORD, method: 'sms' });

    expect(res.status).toBe(400);
  });

  it('refuses email while the address is unverified', async () => {
    const email = `2fa-unverified-${randomUUID()}@e2e.test`;
    await registerPlayer(app, { email, password: PASSWORD, verifyEmail: false });
    await app.container
      .get(DRIZZLE)
      .db.update(user)
      .set({ emailVerified: false })
      .where(eq(user.email, email.toLowerCase()));
    const client = await asPlayer(app.app, { email, password: PASSWORD });

    const res = await client.post('/identity/2fa/enable', { password: PASSWORD, method: 'email' });

    expect(res.status).toBe(400);
  });
});

describe('POST /identity/2fa/otp/send - adapter rejection', () => {
  it('reports a vendor rejection instead of promising a code that never left', async () => {
    const failingDb = await setupTestDb();
    const failingApp = await bootTestApp({
      plugins: [
        ...(await loadExtensions()),
        { id: 'testing-sms-failure', path: smsFailurePluginPath },
      ],
      databaseUrl: failingDb.url,
    });
    try {
      await seedMinimal(failingApp.container, { playerCount: 0 });
      const email = `2fa-smsfail-${randomUUID()}@e2e.test`;
      const userId = await registerPlayer(failingApp, { email, password: PASSWORD });
      await failingApp.container
        .get(DRIZZLE)
        .db.update(user)
        .set({ phoneNumber: `+1555${String(Date.now()).slice(-7)}`, phoneVerified: true })
        .where(eq(user.id, userId));
      const client = await asPlayer(failingApp.app, { email, password: PASSWORD });

      const res = await client.post('/identity/2fa/enable', { password: PASSWORD, method: 'sms' });

      // The vendor's rejection is synchronous (unlike email, which only enqueues a
      // job), so the caller learns about it in the same response instead of being
      // told a code is on its way.
      expect(res.status).toBe(503);
      // Not enabled by the failed attempt - the method the player asked for is what
      // a retry needs, and it survives the failure by design (see the docblock on
      // `enableTwoFactor`).
      const status = (await (await client.get('/identity/2fa/status')).json()) as {
        enabled: boolean;
      };
      expect(status.enabled).toBe(false);
    } finally {
      await failingApp.close();
      await failingDb.dispose();
    }
  });
});

describe('IdentityService.trustCurrentDevice - real second-factor flows', () => {
  it('trusts the device for a real authenticator enrolment', async () => {
    const { client } = await newPlayer();

    const enable = await client.post('/identity/2fa/enable', { password: PASSWORD, method: 'app' });
    expect(enable.status).toBe(200);
    const { totpUri, backupCodes } = (await enable.json()) as {
      totpUri: string;
      backupCodes: string[];
    };
    expect(backupCodes.length).toBeGreaterThan(0);
    const secret = secretFromTotpUri(totpUri);

    const verify = await client.post('/identity/2fa/verify', {
      code: totpCode(secret),
      method: 'totp',
    });
    expect(verify.status).toBe(200);
    const live = followCookie(verify);

    // `trustCurrentDevice` replays a full sign-in leg internally and spends a fresh
    // code against it - this is the one route no other test drives against the real
    // better-auth stack, so a code generated from the enrolled secret has to clear a
    // pending-2FA cookie this call mints for itself, not one left over from `verify`.
    const trust = await live.post('/identity/admin-security/trusted-devices/trust', {
      password: PASSWORD,
      code: totpCode(secret),
    });

    expect(trust.status).toBe(200);
  });

  it('refuses to trust a device for an email-enrolled account, without spending a lockout attempt', async () => {
    clearCapturedEmails();
    const { email, client } = await newPlayer();
    await client.post('/identity/2fa/enable', { password: PASSWORD, method: 'email' });
    const verify = await client.post('/identity/2fa/verify', {
      code: await codeFromEmail(email),
      method: 'otp',
    });
    const live = followCookie(verify);

    // A pushed code is keyed to the challenge that requested it - the fresh one this
    // route would mint internally has no code sent for it yet, so letting the call
    // through would only fail as an unwinnable wrong-code attempt. Refusing up front
    // means no lockout attempt is spent on a credential the account can never present.
    const trust = await live.post('/identity/admin-security/trusted-devices/trust', {
      password: PASSWORD,
      code: '000000',
    });

    expect(trust.status).toBe(409);
    const status = (await (await live.get('/identity/2fa/status')).json()) as { enabled: boolean };
    expect(status.enabled).toBe(true);
  });
});
