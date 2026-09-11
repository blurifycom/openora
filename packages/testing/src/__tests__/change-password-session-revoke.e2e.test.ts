import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { session } from '@openora/core/pam/schema/identity';
import {
  setupTestDb,
  bootTestApp,
  registerPlayer,
  seedMinimal,
  type TestDb,
  type TestApp,
} from '../index.js';

/**
 * The two halves of "invalidate all other sessions on password change" that only
 * show up end to end:
 *
 *  - `streamSession` (`GET /identity/session/stream`) must push `{ type: 'revoked' }`
 *    to the player's OTHER open connections but NOT to the tab that changed the
 *    password. The suppression compares `event.exceptSessionId` against the id the SSE
 *    connection captured at stream-open, so it can only be exercised with two real
 *    sessions and two live streams.
 *  - `revokeOtherSessions` makes better-auth mint the caller's replacement session with
 *    no `dontRememberMe` argument. A caller who signed in with `rememberMe: false` must
 *    still end up with a short-lived row, not a silently promoted 30-day one.
 */

let db: TestDb;
let app: TestApp;

const PASSWORD = 'password1234';
const NEW_PASSWORD = 'brand-new-password-9999';
const DAY_MS = 24 * 60 * 60 * 1000;

async function login(email: string, rememberMe: boolean): Promise<string> {
  const res = await app.app.request('/identity/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, rememberMe }),
  });
  if (!res.ok) {
    throw new Error(`login failed (${res.status}): ${await res.text()}`);
  }
  // Carry every cookie better-auth set (the session token AND, for rememberMe:false,
  // the signed `dont_remember` marker) exactly as a browser would echo them back.
  return (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]?.trim())
    .filter((pair): pair is string => Boolean(pair))
    .join('; ');
}

/**
 * Starts draining an SSE response immediately (which is what makes the route's
 * generator subscribe to the event bus) and resolves the first time a `revoked`
 * event lands, or `null` if the stream ends first.
 */
function watchForRevoked(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let settle!: (value: 'revoked' | null) => void;
  const result = new Promise<'revoked' | null>((resolve) => {
    settle = resolve;
  });
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          settle(null);
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        if (/"type"\s*:\s*"revoked"/.test(buffer)) {
          settle('revoked');
          return;
        }
      }
    } catch {
      settle(null);
    }
  })();
  return {
    result,
    async close() {
      await reader.cancel().catch(() => {});
    },
  };
}

const withTimeout = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

const newPlayer = async (label: string): Promise<{ email: string; userId: string }> => {
  const email = `chpw-${label}-${randomUUID()}@e2e.test`;
  const userId = await registerPlayer(app, { email, password: PASSWORD });
  return { email, userId };
};

/**
 * The single session left after `revokeOtherSessions` - better-auth deletes every row
 * for the user and mints exactly one. `changePassword` returns only `{ success: true }`,
 * so the rotated row is found by user, not by token.
 */
const rotatedSessionTtlMs = async (userId: string): Promise<number> => {
  const rows = await app.container
    .get(DRIZZLE)
    .db.select({ expiresAt: session.expiresAt })
    .from(session)
    .where(eq(session.userId, userId));
  expect(rows).toHaveLength(1);
  return rows[0]!.expiresAt.getTime() - Date.now();
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

describe('POST /identity/password/change + GET /identity/session/stream', () => {
  it('force-logs-out the other tab and spares the one that changed the password', async () => {
    const { email } = await newPlayer('revoke');
    const actingCookie = await login(email, true);
    const otherCookie = await login(email, true);

    const actingStream = watchForRevoked(
      await app.app.request('/identity/session/stream', { headers: { cookie: actingCookie } }),
    );
    const otherStream = watchForRevoked(
      await app.app.request('/identity/session/stream', { headers: { cookie: otherCookie } }),
    );
    // Let both route generators attach their event-bus listeners before the change.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const res = await app.app.request('/identity/password/change', {
      method: 'POST',
      headers: { cookie: actingCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
    });
    expect(res.status).toBe(200);

    await expect(withTimeout(otherStream.result, 4000, null)).resolves.toBe('revoked');
    await expect(withTimeout(actingStream.result, 1500, null)).resolves.toBeNull();

    await actingStream.close();
    await otherStream.close();

    // A silent push is not the same as a working session: revokeOtherSessions deletes
    // the acting tab's PRE-change session row too and mints a fresh one, so the only
    // proof it survives is that the rotated cookie authenticates - and that the old
    // one, now deleted, no longer does.
    const rotatedCookie = (res.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(';')[0]?.trim())
      .find((pair): pair is string => pair !== undefined && pair.includes('session_token'));
    expect(rotatedCookie).toBeDefined();

    const withRotatedCookie = await app.app.request('/identity/security/me', {
      headers: { cookie: rotatedCookie! },
    });
    expect(withRotatedCookie.status).toBe(200);

    const withPreChangeCookie = await app.app.request('/identity/security/me', {
      headers: { cookie: actingCookie },
    });
    expect(withPreChangeCookie.status).toBe(401);
  });

  it('keeps the rotated session short-lived when the caller did not ask to be remembered', async () => {
    const { email, userId } = await newPlayer('ttl');
    const cookie = await login(email, false);

    const res = await app.app.request('/identity/password/change', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
    });
    expect(res.status).toBe(200);

    const ttlMs = await rotatedSessionTtlMs(userId);
    // better-auth's own `dontRememberMe` TTL is 24h; allow an hour of slack, and assert
    // it is nowhere near the 30-day `session.expiresIn` default.
    expect(ttlMs).toBeLessThan(DAY_MS + 60 * 60 * 1000);
    expect(ttlMs).toBeGreaterThan(DAY_MS - 60 * 60 * 1000);
  });

  it('leaves the rotated session at full length for a remembered caller', async () => {
    const { email, userId } = await newPlayer('remember');
    const cookie = await login(email, true);

    const res = await app.app.request('/identity/password/change', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
    });
    expect(res.status).toBe(200);

    expect(await rotatedSessionTtlMs(userId)).toBeGreaterThan(7 * DAY_MS);
  });
});
