import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NOTIFICATION_DELIVERY_ADAPTER } from '@blurifycom/core/contracts';
import { startHarness, type IntegrationHarness } from './harness.js';

const EMAIL = 'player.1@demo.igaming.dev';
const OLD_PASSWORD = 'password123';
const NEW_PASSWORD = 'brandnew-password-1';

const json = { 'content-type': 'application/json' };

describe('password reset (integration)', () => {
  let h: IntegrationHarness;
  const sent: Array<{ to: string; subject: string; body: string }> = [];

  beforeAll(async () => {
    h = await startHarness();
    // Capture the reset email instead of the stdout mock, so we can read the
    // token better-auth emails. register() drops the cached instance, and the
    // identity router resolves the adapter lazily per request, so this takes
    // effect for the forgot call below.
    h.container.register(NOTIFICATION_DELIVERY_ADAPTER, () => ({
      async sendEmail(to: string, subject: string, body: string) {
        sent.push({ to, subject, body });
      },
    }));
  });
  afterAll(async () => {
    await h?.stop();
  });

  it('emails a reset token, resets the password, and the new password works', async () => {
    const forgotRes = await h.app.request('/identity/password/forgot', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: EMAIL }),
    });
    expect(forgotRes.status).toBe(200);
    expect(sent.length).toBeGreaterThan(0);

    const token = sent.at(-1)?.body.match(/Reset token: (\S+)/)?.[1];
    expect(token).toBeTruthy();

    const resetRes = await h.app.request('/identity/password/reset', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ token, newPassword: NEW_PASSWORD }),
    });
    expect(resetRes.status).toBe(200);

    // New password authenticates.
    const okLogin = await h.app.request('/identity/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: EMAIL, password: NEW_PASSWORD }),
    });
    expect(okLogin.status).toBe(200);

    // Old password no longer works.
    const badLogin = await h.app.request('/identity/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: EMAIL, password: OLD_PASSWORD }),
    });
    expect(badLogin.status).toBeGreaterThanOrEqual(400);
  });

  it('does not reveal whether an email exists', async () => {
    const res = await h.app.request('/identity/password/forgot', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'nobody@nowhere.test' }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects an invalid reset token', async () => {
    const res = await h.app.request('/identity/password/reset', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ token: 'not-a-real-token', newPassword: NEW_PASSWORD }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
