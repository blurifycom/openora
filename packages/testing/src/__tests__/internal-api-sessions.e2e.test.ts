import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadExtensions } from '@openora/core/server';
import {
  asAdmin,
  bootE2e,
  closeE2e,
  registerAndMaterializePlayer,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';

const SECRET = randomBytes(32).toString('hex');
const WHOAMI = '/internal/v1/probe/whoami';
const AS_ADMIN = '/internal/v1/probe/as-admin';
// The app under test checks the signature against its own SERVICE_NAME.
const AUDIENCE = process.env['SERVICE_NAME'] || 'monolith';

let db: TestDb;
let app: TestApp;
let admin: TestClient;
let player: TestClient;
const savedSecrets = process.env['INTERNAL_API_SECRETS'];

// Signed by hand, as another service would: the signing helper is not public API.
function signedGet(path: string): Record<string, string> {
  const timestamp = String(Date.now());
  const emptyBodyHash = createHash('sha256').update('').digest('hex');
  const canonical = ['chat', AUDIENCE, timestamp, 'GET', path, '', emptyBodyHash].join('\n');
  return {
    'x-openora-service': 'chat',
    'x-openora-timestamp': timestamp,
    'x-openora-signature': createHmac('sha256', SECRET).update(canonical).digest('hex'),
  };
}

beforeAll(async () => {
  process.env['INTERNAL_API_SECRETS'] = SECRET;
  ({ db, app } = await bootE2e({
    plugins: [
      ...(await loadExtensions()),
      {
        id: 'testing-internal-probe',
        path: fileURLToPath(new URL('../test-internal-probe-plugin.ts', import.meta.url)),
      },
    ],
  }));
  admin = await asAdmin(app.app);
  ({ client: player } = await registerAndMaterializePlayer(app, {
    email: `internal-api-${randomUUID()}@example.test`,
  }));
}, 60_000);

afterAll(async () => {
  if (savedSecrets === undefined) {
    delete process.env['INTERNAL_API_SECRETS'];
  } else {
    process.env['INTERNAL_API_SECRETS'] = savedSecrets;
  }
  await closeE2e({ app, db });
});

describe('/internal/v1 and a signed-in session', () => {
  it.each([
    ['an admin', () => admin, '/audit/logs'],
    ['a player', () => player, '/profile/display-currency'],
  ])('refuses %s session without a service signature', async (_who, client, ownRoute) => {
    // The same session reaches its own surface, so the 401 is the internal gate's.
    expect((await client().get(ownRoute)).status).toBe(200);

    const res = await client().get(WHOAMI);

    expect(res.status).toBe(401);
    expect(await res.text()).toBe('');
  });

  it('serves a signed call as the service alone, with the session cookie stripped', async () => {
    const res = await admin.request(WHOAMI, { method: 'GET', headers: signedGet(WHOAMI) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ caller: 'chat', cookieSeen: false });
  });

  it('refuses an admin check inside a signed call that carries an admin cookie', async () => {
    const res = await admin.request(AS_ADMIN, { method: 'GET', headers: signedGet(AS_ADMIN) });

    expect(res.status).toBe(401);
  });
});
