import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { Hono } from 'hono';
import type { AdminSecurityPolicy } from '../contracts/index.js';
import {
  createInternalClient,
  type InternalClient,
  type InternalContext,
  type RequestSessionResolver,
} from '../server/index.js';
import {
  INTERNAL_API_PREFIX,
  isSignedBy,
  readSignatureHeaders,
} from '../server/runtime/internal-api.js';
import { migrate as migrateIdentity } from '../pam/identity/migrate.js';
import { migrate as migrateProfile } from '../pam/profile/migrate.js';
import { DrizzleAccountReader } from '../pam/identity/adapters/account-reader.service.js';
import { createInternalAccountsRouter } from '../pam/identity/router/internal-accounts.router.js';
import { createInternalSessionRouter } from '../pam/identity/router/internal-sessions.router.js';
import { createTestDb, type TestDb } from './real-infra.js';

const REMOTE_CALLER = 'chat';
const AUDIENCE = 'identity';

const grantsEnrolment: AdminSecurityPolicy = {
  assertEnrolled: async () => {},
  assertSessionIntact: async () => {},
};

export type RemoteIdentity = {
  testDb: TestDb;
  client: InternalClient;
  calls: { path: string }[];
  stop: () => Promise<void>;
  dispose: () => Promise<void>;
};

export async function startRemoteIdentity(
  resolver: RequestSessionResolver,
): Promise<RemoteIdentity> {
  const testDb = await createTestDb([migrateIdentity, migrateProfile]);
  const secret = randomBytes(32).toString('hex');
  const callers = new Set([REMOTE_CALLER]);
  const accounts = createInternalAccountsRouter(new DrizzleAccountReader(testDb.drizzle), callers);
  const { session } = createInternalSessionRouter(resolver, grantsEnrolment, callers);
  const handler = new OpenAPIHandler<InternalContext>({ ...accounts, session });
  const calls: { path: string }[] = [];

  const app = new Hono();
  app.all(`${INTERNAL_API_PREFIX}/*`, async (c) => {
    const url = new URL(c.req.url);
    const signature = readSignatureHeaders(c.req.raw.headers, Date.now());
    if (typeof signature === 'string') {
      return c.body(null, 401);
    }
    const body = Buffer.from(await c.req.raw.clone().arrayBuffer());
    const signed = isSignedBy(
      signature,
      {
        audience: AUDIENCE,
        method: c.req.method,
        pathAndQuery: `${url.pathname}${url.search}`,
        contentType: c.req.header('content-type') ?? '',
        body,
      },
      [secret],
    );
    if (!signed) {
      return c.body(null, 401);
    }
    calls.push({ path: url.pathname.slice(INTERNAL_API_PREFIX.length) });
    const context: InternalContext = {
      request: { headers: {} },
      clientMeta: { ip: null, userAgent: null },
      rawBody: body.toString('utf8'),
      internalCaller: signature.service,
    };
    const { matched, response } = await handler.handle(c.req.raw, {
      prefix: INTERNAL_API_PREFIX,
      context,
    });
    return matched ? c.newResponse(response.body, response) : c.body(null, 404);
  });

  const server: ServerType = await new Promise((resolve) => {
    const listening = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () =>
      resolve(listening),
    );
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('remote identity server has no port');
  }
  const { port }: AddressInfo = address;

  const client = createInternalClient({
    baseUrl: `http://127.0.0.1:${port}`,
    serviceName: REMOTE_CALLER,
    audience: AUDIENCE,
    secrets: secret,
    timeoutMs: 5_000,
  });

  const stop = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      if ('closeAllConnections' in server) {
        server.closeAllConnections();
      }
    });

  return { testDb, client, calls, stop, dispose: () => testDb.drop() };
}
