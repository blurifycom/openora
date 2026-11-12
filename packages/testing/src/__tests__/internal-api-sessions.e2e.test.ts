import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INTERNAL_API_HEADERS, loadExtensions, signInternalRequest } from '@openora/core/server';
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

let db: TestDb;
let app: TestApp;
let admin: TestClient;
let player: TestClient;
const savedSecrets = process.env['INTERNAL_API_SECRETS'];

function signedHeaders(): Record<string, string> {
  const timestamp = String(Date.now());
  return {
    [INTERNAL_API_HEADERS.service]: 'chat',
    [INTERNAL_API_HEADERS.timestamp]: timestamp,
    [INTERNAL_API_HEADERS.signature]: signInternalRequest(
      {
        service: 'chat',
        timestamp,
        method: 'GET',
        pathAndQuery: WHOAMI,
        body: new Uint8Array(),
      },
      SECRET,
    ),
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

  it('serves a signed call as the service alone, never as the session it carries', async () => {
    const res = await admin.request(WHOAMI, { method: 'GET', headers: signedHeaders() });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ caller: 'chat', userId: null });
  });
});
