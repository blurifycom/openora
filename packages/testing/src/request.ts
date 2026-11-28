import type { Hono } from 'hono';

let registrationRequestCount = 0;

export function registrationRequestHeaders(): Record<string, string> {
  const count = registrationRequestCount++;
  return {
    'content-type': 'application/json',
    'x-real-ip': `198.18.${Math.floor(count / 254)}.${(count % 254) + 1}`,
  };
}

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
    for (const [k, v] of Object.entries(baseHeaders)) {
      headers.set(k, v);
    }
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
  if (!cookie) {
    throw new Error(`${label}: login succeeded but no session cookie was set`);
  }
  return makeClient(app, { cookie });
}

export async function asPlayer(
  app: Hono,
  creds: LoginCreds & { email: string },
): Promise<TestClient> {
  return loginAs(app, 'asPlayer', creds.email, creds.password ?? 'password1234');
}

export type AdminCreds = LoginCreds;

export async function asAdmin(app: Hono, creds: AdminCreds = {}): Promise<TestClient> {
  return loginAs(app, 'asAdmin', creds.email ?? 'admin@oss.dev', creds.password ?? 'password1234');
}
