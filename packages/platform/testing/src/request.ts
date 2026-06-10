import type { Hono } from 'hono';

/** A thin wrapper over `app.request` that injects auth headers on every call. */
export type TestClient = {
  request(path: string, init?: RequestInit): Promise<Response>;
  get(path: string): Promise<Response>;
  post(path: string, body?: unknown): Promise<Response>;
  put(path: string, body?: unknown): Promise<Response>;
  patch(path: string, body?: unknown): Promise<Response>;
  del(path: string): Promise<Response>;
};

function makeClient(app: Hono, baseHeaders: Record<string, string>): TestClient {
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    for (const [k, v] of Object.entries(baseHeaders)) headers.set(k, v);
    return app.request(path, { ...init, headers });
  };
  const withBody = (method: string) => (path: string, body?: unknown) =>
    call(path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  return {
    request: call,
    get: (path) => call(path, { method: 'GET' }),
    post: withBody('POST'),
    put: withBody('PUT'),
    patch: withBody('PATCH'),
    del: (path) => call(path, { method: 'DELETE' }),
  };
}

export type LoginCreds = {
  email?: string;
  password?: string;
};

/**
 * Log in via `/identity/login` (better-auth) and return a client carrying the
 * verified session cookie. Throws if the login fails or no cookie is set.
 */
async function loginAs(
  app: Hono,
  label: string,
  email: string,
  password: string,
): Promise<TestClient> {
  const res = await app.request('/identity/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`${label} login failed (${res.status}): ${await res.text()}`);
  }
  const raw = res.headers.get('set-cookie') ?? '';
  const cookie = raw.split(';')[0] ?? '';
  if (!cookie) throw new Error(`${label}: login succeeded but no session cookie was set`);
  return makeClient(app, { cookie });
}

/**
 * A client that authenticates as a player by logging in with the player's REAL
 * credentials (verified better-auth session cookie) - no more trusting an
 * `x-user-id` header (W1, ADR-0019). Seeded players use `player.<n>@demo.igaming.dev`
 * / `password123` (see seedDemoData). Pass the seeded player's email; defaults to
 * the standard player password.
 */
export async function asPlayer(
  app: Hono,
  creds: LoginCreds & { email: string },
): Promise<TestClient> {
  return loginAs(app, 'asPlayer', creds.email, creds.password ?? 'password123');
}

export type AdminCreds = LoginCreds;

/**
 * Log in via `/identity/login` (better-auth) and return a client carrying the
 * session cookie. Defaults to the seeded admin (`admin@oss.dev` / `password123`).
 */
export async function asAdmin(app: Hono, creds: AdminCreds = {}): Promise<TestClient> {
  return loginAs(app, 'asAdmin', creds.email ?? 'admin@oss.dev', creds.password ?? 'password123');
}
