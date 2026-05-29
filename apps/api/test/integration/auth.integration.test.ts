import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { asAdmin } from '@oss/testing';
import { startHarness, type IntegrationHarness } from './harness.js';

const ADMIN_ROUTE = '/compliance/geo-rules'; // guarded by adminGuard.assert(context)

async function sessionCookie(app: IntegrationHarness['app'], email: string, password: string) {
  const res = await app.request('/identity/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed (${res.status})`);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

describe('admin guard (integration)', () => {
  let h: IntegrationHarness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h?.stop();
  });

  it('rejects an unauthenticated caller with 401', async () => {
    const res = await h.app.request(ADMIN_ROUTE, { method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('rejects an authenticated player with 403', async () => {
    const cookie = await sessionCookie(h.app, 'player.1@demo.igaming.dev', 'password123');
    const res = await h.app.request(ADMIN_ROUTE, { method: 'GET', headers: { cookie } });
    expect(res.status).toBe(403);
  });

  it('accepts the admin and can add a geo rule', async () => {
    const admin = await asAdmin(h.app);
    const list = await admin.get(ADMIN_ROUTE);
    expect(list.status).toBe(200);

    const added = await admin.post(ADMIN_ROUTE, { countryCode: 'US', action: 'allow' });
    expect(added.status).toBe(200);
    const rule = (await added.json()) as { countryCode: string; action: string };
    expect(rule.countryCode).toBe('US');
    expect(rule.action).toBe('allow');
  });
});
