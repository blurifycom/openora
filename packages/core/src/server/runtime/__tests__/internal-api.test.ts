import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redisUrlForWorker } from '@openora/core/testing';
import { createApp, type CreatedApp } from '../create-app.js';
import {
  INTERNAL_API_HEADERS,
  INTERNAL_API_SESSION_HEADERS,
  parseInternalApiSecrets,
  signInternalRequest,
} from '../internal-api.js';
import { createInternalClient, InternalApiError } from '../internal-client.js';
import { internalProbeHits } from './fixtures/internal-probe-plugin.js';

const internalApiLog = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../kernel/logger.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../kernel/logger.js')>();
  return {
    ...original,
    createLogger: (name: string) =>
      name === 'internal-api' ? internalApiLog : original.createLogger(name),
  };
});

// Never queried: the internal surface reads no session, and the probe routes touch no table.
const DUMMY_DATABASE_URL = 'postgres://test:[redacted]@127.0.0.1:1/internal_api_test';
const PROBE_PATH = fileURLToPath(new URL('./fixtures/internal-probe-plugin.ts', import.meta.url));
const ENV_KEYS = ['REDIS_URL', 'INTERNAL_API_SECRETS', 'SERVICE_NAME'] as const;
// The SERVICE_NAME every booted app runs as, so the audience a call is signed for.
const AUDIENCE = 'wallet';

const OLD_SECRET = randomBytes(32).toString('hex');
const NEW_SECRET = randomBytes(32).toString('hex');

const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const apps: CreatedApp[] = [];
const servers: ServerType[] = [];

async function boot(secrets: string | undefined): Promise<CreatedApp['app']> {
  process.env['REDIS_URL'] = redisUrlForWorker();
  process.env['SERVICE_NAME'] = AUDIENCE;
  if (secrets === undefined) {
    delete process.env['INTERNAL_API_SECRETS'];
  } else {
    process.env['INTERNAL_API_SECRETS'] = secrets;
  }
  const created = await createApp({
    plugins: [{ id: 'internal-probe', path: PROBE_PATH }],
    databaseUrl: DUMMY_DATABASE_URL,
  });
  apps.push(created);
  return created.app;
}

async function listen(app: Pick<CreatedApp['app'], 'fetch'>): Promise<string> {
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

type SignOptions = {
  method?: string;
  body?: string;
  secret?: string;
  service?: string;
  timestamp?: number;
  audience?: string;
  headers?: Record<string, string>;
  // What the signature covers, when a test sends something else.
  signedPath?: string;
  signedBody?: string;
  signedContentType?: string;
};

function signedInit(path: string, options: SignOptions = {}): RequestInit {
  const method = options.method ?? 'POST';
  const body = options.body ?? (method === 'GET' ? '' : '{"amount":5}');
  const contentType = body === '' ? '' : 'application/json';
  const timestamp = String(options.timestamp ?? Date.now());
  const service = options.service ?? 'chat';
  const signature = signInternalRequest(
    {
      service,
      audience: options.audience ?? AUDIENCE,
      timestamp,
      method,
      pathAndQuery: options.signedPath ?? path,
      contentType: options.signedContentType ?? contentType,
      body: new TextEncoder().encode(options.signedBody ?? body),
    },
    options.secret ?? NEW_SECRET,
  );
  return {
    method,
    headers: {
      ...(contentType === '' ? {} : { 'content-type': contentType }),
      ...options.headers,
      [INTERNAL_API_HEADERS.service]: service,
      [INTERNAL_API_HEADERS.timestamp]: timestamp,
      [INTERNAL_API_HEADERS.signature]: signature,
    },
    ...(body === '' ? {} : { body }),
  };
}

async function expectRefused(res: Response, status = 401) {
  expect(res.status).toBe(status);
  expect(await res.text()).toBe('');
}

const ECHO = '/internal/v1/probe/echo';

beforeEach(() => {
  internalApiLog.warn.mockClear();
  for (const route of Object.keys(internalProbeHits())) {
    delete internalProbeHits()[route];
  }
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.close();
  }
  await Promise.allSettled(apps.splice(0).map((created) => created.close()));
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('parseInternalApiSecrets', () => {
  it('is off when unset or blank, and keeps the signing secret first', () => {
    expect(parseInternalApiSecrets(undefined)).toEqual([]);
    expect(parseInternalApiSecrets(' , ')).toEqual([]);
    expect(parseInternalApiSecrets(` ${NEW_SECRET} ,${OLD_SECRET}`)).toEqual([
      NEW_SECRET,
      OLD_SECRET,
    ]);
  });

  it('refuses a short secret without echoing it', () => {
    expect(() => parseInternalApiSecrets(`${NEW_SECRET},short-secret`)).toThrow(
      /at least 32 characters/,
    );
    expect(() => parseInternalApiSecrets('short-secret')).not.toThrow(/short-secret/);
  });
});

describe('the /internal/v1 surface', () => {
  it('serves a signed call and names the calling service to the handler', async () => {
    const app = await boot(NEW_SECRET);

    const res = await app.request(ECHO, signedInit(ECHO));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      caller: 'chat',
      input: { amount: 5 },
      signedIn: false,
      sessionHeaders: [],
    });
  });

  it('strips every session header from a signed call before the handler sees it', async () => {
    const app = await boot(NEW_SECRET);
    const sessionHeaders = Object.fromEntries(
      INTERNAL_API_SESSION_HEADERS.map((name) => [name, 'forged']),
    );

    const res = await app.request(ECHO, signedInit(ECHO, { headers: sessionHeaders }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ signedIn: false, sessionHeaders: [] });
  });

  it('refuses a call signed for another service', async () => {
    const app = await boot(NEW_SECRET);

    await expectRefused(await app.request(ECHO, signedInit(ECHO, { audience: 'chat' })));
    expect(internalProbeHits()['echo']).toBeUndefined();
  });

  it('refuses a content type other than the one signed', async () => {
    const app = await boot(NEW_SECRET);

    await expectRefused(
      await app.request(ECHO, signedInit(ECHO, { signedContentType: 'text/plain' })),
    );
    expect(internalProbeHits()['echo']).toBeUndefined();
  });

  it('refuses a stale call on its headers, before reading an oversized body', async () => {
    const app = await boot(NEW_SECRET);
    const body = JSON.stringify({ amount: 5, pad: 'x'.repeat(1_048_576) });

    await expectRefused(
      await app.request(ECHO, signedInit(ECHO, { body, timestamp: Date.now() - 61_000 })),
    );
  });

  it('signs the query string with the path', async () => {
    const app = await boot(NEW_SECRET);
    const read = '/internal/v1/probe/read?player=1';

    const ok = await app.request(read, signedInit(read, { method: 'GET' }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ caller: 'chat' });

    const tampered = '/internal/v1/probe/read?player=2';
    await expectRefused(await app.request(tampered, signedInit(read, { method: 'GET' })));
  });

  it.each(Object.values(INTERNAL_API_HEADERS))('refuses a call without %s', async (header) => {
    const app = await boot(NEW_SECRET);
    const init = signedInit(ECHO);
    const headers = new Headers(init.headers);
    headers.delete(header);

    await expectRefused(await app.request(ECHO, { ...init, headers }));
    expect(internalProbeHits()['echo']).toBeUndefined();
  });

  it.each([
    ['a malformed signature', { [INTERNAL_API_HEADERS.signature]: 'not-hex' }],
    ['a forged signature', { [INTERNAL_API_HEADERS.signature]: '0'.repeat(64) }],
    ['another service name than the one signed', { [INTERNAL_API_HEADERS.service]: 'wallet' }],
    [
      'a service name outside the allowed characters',
      { [INTERNAL_API_HEADERS.service]: 'chat evil' },
    ],
  ])('refuses %s', async (_case, override) => {
    const app = await boot(NEW_SECRET);
    const init = signedInit(ECHO);

    await expectRefused(
      await app.request(ECHO, { ...init, headers: { ...init.headers, ...override } }),
    );
    expect(internalProbeHits()['echo']).toBeUndefined();
  });

  it('refuses a call signed with a secret it does not hold', async () => {
    const app = await boot(NEW_SECRET);

    await expectRefused(
      await app.request(ECHO, signedInit(ECHO, { secret: randomBytes(32).toString('hex') })),
    );
  });

  it('refuses a body other than the one signed', async () => {
    const app = await boot(NEW_SECRET);

    await expectRefused(
      await app.request(
        ECHO,
        signedInit(ECHO, { body: '{"amount":500}', signedBody: '{"amount":5}' }),
      ),
    );
    expect(internalProbeHits()['echo']).toBeUndefined();
  });

  it('refuses a signature replayed on another path', async () => {
    const app = await boot(NEW_SECRET);
    const crash = '/internal/v1/probe/crash';

    await expectRefused(await app.request(crash, signedInit(crash, { signedPath: ECHO })));
    expect(internalProbeHits()['crash']).toBeUndefined();
  });

  it('allows 60s of clock skew either way and no more', async () => {
    const app = await boot(NEW_SECRET);
    const now = Date.now();

    const within = await app.request(ECHO, signedInit(ECHO, { timestamp: now - 55_000 }));
    expect(within.status).toBe(200);
    await expectRefused(await app.request(ECHO, signedInit(ECHO, { timestamp: now - 61_000 })));
    await expectRefused(await app.request(ECHO, signedInit(ECHO, { timestamp: now + 61_000 })));
  });

  it('verifies with every listed secret while a rotation is under way', async () => {
    const rotating = await boot(`${NEW_SECRET},${OLD_SECRET}`);
    expect((await rotating.request(ECHO, signedInit(ECHO, { secret: OLD_SECRET }))).status).toBe(
      200,
    );
    expect((await rotating.request(ECHO, signedInit(ECHO, { secret: NEW_SECRET }))).status).toBe(
      200,
    );

    const rotated = await boot(NEW_SECRET);
    await expectRefused(await rotated.request(ECHO, signedInit(ECHO, { secret: OLD_SECRET })));
  });

  it('refuses every internal call while INTERNAL_API_SECRETS is unset', async () => {
    const app = await boot(undefined);

    await expectRefused(await app.request(ECHO, signedInit(ECHO)));
    await expectRefused(await app.request('/internal/v1/nothing-here', signedInit(ECHO)));
    expect(internalProbeHits()['echo']).toBeUndefined();
  });

  it('never reads a session: a cookie or bearer token alone is refused', async () => {
    const app = await boot(NEW_SECRET);

    await expectRefused(
      await app.request(ECHO, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'better-auth.session_token=forged',
          authorization: 'Bearer forged',
        },
        body: '{"amount":5}',
      }),
    );
  });

  it('logs one warn line per refusal, without the signature', async () => {
    const app = await boot(NEW_SECRET);
    const init = signedInit(ECHO, { secret: randomBytes(32).toString('hex') });
    const signature = new Headers(init.headers).get(INTERNAL_API_HEADERS.signature);

    await expectRefused(await app.request(ECHO, init));

    expect(internalApiLog.warn).toHaveBeenCalledTimes(1);
    expect(internalApiLog.warn).toHaveBeenCalledWith(
      { service: 'chat', method: 'POST', path: ECHO, reason: 'bad_signature' },
      'internal call refused',
    );
    expect(JSON.stringify(internalApiLog.warn.mock.calls)).not.toContain(signature);
  });

  it('keeps an internal router closed when it is mounted on the public surface', async () => {
    const app = await boot(NEW_SECRET);

    const res = await app.request('/probe-leak');

    expect(res.status).toBe(404);
    expect(internalProbeHits()['leak']).toBeUndefined();
  });

  it('answers 401 to an unsigned call on any path, 404 only once signed', async () => {
    const app = await boot(NEW_SECRET);
    const missing = '/internal/v1/nothing-here';

    await expectRefused(await app.request(missing, { method: 'POST' }));
    await expectRefused(await app.request(missing, signedInit(missing)), 404);
  });

  it('refuses a body over the limit before verifying it', async () => {
    const app = await boot(NEW_SECRET);
    const body = JSON.stringify({ amount: 5, pad: 'x'.repeat(1_048_576) });

    await expectRefused(await app.request(ECHO, signedInit(ECHO, { body })), 413);
  });

  it('keeps internal routes out of the public OpenAPI document', async () => {
    const app = await boot(NEW_SECRET);

    const spec = (await (await app.request('/openapi.json')).json()) as { paths?: object };
    expect(Object.keys(spec.paths ?? {}).filter((path) => path.includes('probe/'))).toEqual([]);
  });
});

describe('raw body capture on the public routes', () => {
  // A chunked body sends no content-length, so only the stream bound stops it.
  function chunkedBody(bytes: number): ReadableStream<Uint8Array> {
    const chunk = new Uint8Array(64 * 1024).fill(120);
    let sent = 0;
    return new ReadableStream({
      pull(controller) {
        if (sent >= bytes) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        sent += chunk.byteLength;
      },
    });
  }

  async function postChunked(baseUrl: string, bytes: number) {
    const res = await fetch(`${baseUrl}/probe-raw`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: chunkedBody(bytes),
      duplex: 'half',
      signal: AbortSignal.timeout(5_000),
    } as RequestInit);
    return (await res.json()) as { captured: boolean };
  }

  it('captures a chunked body under the cap', async () => {
    const baseUrl = await listen(await boot(NEW_SECRET));

    await expect(postChunked(baseUrl, 256 * 1024)).resolves.toEqual({ captured: true });
  });

  it.each([2, 4])(
    'leaves rawBody unset for a %i MiB chunked body instead of hanging',
    async (mebibytes) => {
      const baseUrl = await listen(await boot(NEW_SECRET));

      await expect(postChunked(baseUrl, mebibytes * 1024 * 1024)).resolves.toEqual({
        captured: false,
      });
    },
  );
});

describe('createInternalClient', () => {
  const client = (
    baseUrl: string,
    overrides: { secrets?: string; timeoutMs?: number; audience?: string } = {},
  ) =>
    createInternalClient({
      baseUrl,
      serviceName: 'chat',
      audience: overrides.audience ?? AUDIENCE,
      secrets: overrides.secrets ?? `${NEW_SECRET},${OLD_SECRET}`,
      timeoutMs: overrides.timeoutMs ?? 2_000,
    });

  it('signs a call the surface accepts and resolves the reply', async () => {
    const baseUrl = await listen(await boot(NEW_SECRET));

    await expect(client(baseUrl).request('POST', '/probe/echo', { amount: 7 })).resolves.toEqual({
      caller: 'chat',
      input: { amount: 7 },
      signedIn: false,
      sessionHeaders: [],
    });
    await expect(client(baseUrl).request('GET', '/probe/read')).resolves.toEqual({
      caller: 'chat',
    });
  });

  it('is refused by a service it did not sign for', async () => {
    const baseUrl = await listen(await boot(NEW_SECRET));

    await expect(
      client(baseUrl, { audience: 'bonus' }).request('POST', '/probe/echo', { amount: 1 }),
    ).rejects.toMatchObject({ kind: 'client', status: 401 });
  });

  it('cannot be built without a secret', () => {
    expect(() => client('http://127.0.0.1:1', { secrets: ' ' })).toThrow(/INTERNAL_API_SECRETS/);
  });

  it.each([
    'probe/echo',
    '/probe/../admin',
    '/probe/%2e%2e/admin',
    '/probe/./echo',
    '/probe/echo?amount=1',
    '/probe/echo#top',
    '/probe/echo?',
  ])('refuses to send the path %s', async (path) => {
    const baseUrl = await listen(await boot(NEW_SECRET));

    await expect(client(baseUrl).request('POST', path, {})).rejects.toMatchObject({
      kind: 'client',
      status: undefined,
    });
    expect(internalProbeHits()).toEqual({});
  });

  it('wraps a body JSON cannot serialize in a client error, before any request', async () => {
    const baseUrl = await listen(await boot(NEW_SECRET));
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;

    for (const body of [{ amount: 1n }, cycle]) {
      await expect(client(baseUrl).request('POST', '/probe/echo', body)).rejects.toMatchObject({
        name: 'InternalApiError',
        kind: 'client',
      });
    }
    expect(internalProbeHits()).toEqual({});
  });

  it('throws a timeout error and does not retry', async () => {
    const baseUrl = await listen(await boot(NEW_SECRET));

    const call = client(baseUrl, { timeoutMs: 100 }).request('POST', '/probe/slow', {});

    await expect(call).rejects.toMatchObject({ name: 'InternalApiError', kind: 'timeout' });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(internalProbeHits()['slow']).toBe(1);
  });

  it('throws a server error on a 5xx and does not retry', async () => {
    const baseUrl = await listen(await boot(NEW_SECRET));

    const error = await client(baseUrl)
      .request('POST', '/probe/crash', {})
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(InternalApiError);
    expect(error).toMatchObject({ kind: 'server', status: 500 });
    expect(internalProbeHits()['crash']).toBe(1);
  });

  it('throws a client error on a 4xx', async () => {
    const baseUrl = await listen(await boot(NEW_SECRET));

    await expect(
      client(baseUrl, { secrets: OLD_SECRET }).request('POST', '/probe/echo', { amount: 1 }),
    ).rejects.toMatchObject({ kind: 'client', status: 401 });
    expect(internalProbeHits()['echo']).toBeUndefined();
  });

  it('keeps a 4xx a client error when a proxy answers with HTML', async () => {
    const baseUrl = await listen({
      fetch: () => new Response('<h1>Not Found</h1>', { status: 404 }),
    });

    await expect(client(baseUrl).request('GET', '/probe/read')).rejects.toMatchObject({
      kind: 'client',
      status: 404,
      body: '<h1>Not Found</h1>',
    });
  });

  it('throws a network error when nothing answers', async () => {
    const baseUrl = await listen(await boot(NEW_SECRET));
    for (const server of servers.splice(0)) {
      await new Promise((resolve) => server.close(resolve));
    }

    await expect(client(baseUrl).request('POST', '/probe/echo', {})).rejects.toMatchObject({
      kind: 'network',
    });
  });
});
