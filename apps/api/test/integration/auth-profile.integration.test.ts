import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type IntegrationHarness } from './harness.js';

const EMAIL = 'player.2@demo.igaming.dev';
const PASSWORD = 'password123';

const json = { 'content-type': 'application/json' };

async function loginCookie(app: IntegrationHarness['app']): Promise<string> {
  const res = await app.request('/identity/login', {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed (${res.status})`);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

describe('profile + password change (integration)', () => {
  let h: IntegrationHarness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h?.stop();
  });

  it('updates the identity display name', async () => {
    const cookie = await loginCookie(h.app);
    const res = await h.app.request('/identity/profile', {
      method: 'PATCH',
      headers: { ...json, cookie },
      body: JSON.stringify({ name: 'Renamed Player' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { name: string } };
    expect(body.user.name).toBe('Renamed Player');
  });

  it('changes the password and rejects a wrong current password', async () => {
    const cookie = await loginCookie(h.app);
    const newPassword = 'rotated-password-9';

    const ok = await h.app.request('/identity/password/change', {
      method: 'POST',
      headers: { ...json, cookie },
      body: JSON.stringify({ currentPassword: PASSWORD, newPassword }),
    });
    expect(ok.status).toBe(200);

    const bad = await h.app.request('/identity/password/change', {
      method: 'POST',
      headers: { ...json, cookie },
      body: JSON.stringify({ currentPassword: 'definitely-wrong', newPassword: 'whatever-123' }),
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });

  it('gets and updates the player profile preferences (verified session)', async () => {
    const player = await h.asPlayer();

    const got = await player.get('/profile');
    expect(got.status).toBe(200);

    const updated = await player.patch('/profile', { currency: 'EUR', displayName: 'Ace' });
    expect(updated.status).toBe(200);
    const body = (await updated.json()) as { currency: string; displayName: string };
    expect(body.currency).toBe('EUR');
    expect(body.displayName).toBe('Ace');
  });
});
