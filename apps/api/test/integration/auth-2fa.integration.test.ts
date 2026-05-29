import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createOTP } from '@better-auth/utils/otp';
import { base32 } from '@better-auth/utils/base32';
import { startHarness, type IntegrationHarness } from './harness.js';

const EMAIL = 'player.1@demo.igaming.dev';
const PASSWORD = 'password123';

const json = { 'content-type': 'application/json' };

// Authenticate and return the session cookie (2FA routes need a real session,
// not the x-user-id shortcut).
async function loginCookie(app: IntegrationHarness['app']): Promise<string> {
  const res = await app.request('/identity/login', {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed (${res.status})`);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

describe('two-factor TOTP (integration)', () => {
  let h: IntegrationHarness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h?.stop();
  });

  it('enrols, verifies a real TOTP, and gates the next login', async () => {
    const cookie = await loginCookie(h.app);

    // Enrol -> returns the otpauth URI + backup codes.
    const enableRes = await h.app.request('/identity/2fa/enable', {
      method: 'POST',
      headers: { ...json, cookie },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(enableRes.status).toBe(200);
    const enrol = (await enableRes.json()) as { totpUri: string; backupCodes: string[] };
    expect(enrol.totpUri).toContain('otpauth://');
    expect(enrol.backupCodes.length).toBeGreaterThan(0);

    const secretParam = new URL(enrol.totpUri).searchParams.get('secret');
    expect(secretParam).toBeTruthy();
    // url() base32-encodes the secret string; totp()/verify() use the original
    // string as the HMAC key, so decode the bytes back to that ASCII string.
    const secret = new TextDecoder().decode(base32.decode(secretParam!));

    // A bogus code is rejected.
    const badRes = await h.app.request('/identity/2fa/verify', {
      method: 'POST',
      headers: { ...json, cookie },
      body: JSON.stringify({ code: '000000' }),
    });
    expect(badRes.status).toBeGreaterThanOrEqual(400);

    // A real TOTP computed from the enrolment secret is accepted.
    const code = await createOTP(secret, { period: 30, digits: 6 }).totp();
    const verifyRes = await h.app.request('/identity/2fa/verify', {
      method: 'POST',
      headers: { ...json, cookie },
      body: JSON.stringify({ code }),
    });
    expect(verifyRes.status).toBe(200);

    // A fresh login for the now-2FA-enabled account is withheld pending 2FA.
    const loginRes = await h.app.request('/identity/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const body = (await loginRes.json()) as { twoFactorRedirect?: boolean; session?: unknown };
    expect(body.twoFactorRedirect).toBe(true);
    expect(body.session).toBeUndefined();
  });
});
