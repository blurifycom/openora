import { createApp, type CreateAppConfig, type Container } from '@blurifycom/core/server';
import {
  user,
  session,
  account,
  verification,
  twoFactor,
} from '@blurifycom/core/pam/schema/identity';
import type { Hono } from 'hono';

export type TestApp = {
  /** The Hono app - drive it directly with `app.request(path, init)`. */
  app: Hono;
  /** The composition container, for resolving services/tokens in assertions. */
  container: Container;
  /** Dispose the container (closes the DB pool, drains workers). */
  close(): Promise<void>;
};

export type BootTestAppConfig = Pick<CreateAppConfig, 'plugins' | 'contract' | 'igaming'> & {
  databaseUrl: string;
};

/**
 * Boot the full Hono + oRPC app in-process against a test database. No network
 * listener is opened - exercise routes with `app.request()` (the canonical Hono
 * test approach). OpenAPI emission is disabled; CORS is left at the default.
 *
 * Pass the same `plugins` + `contract` the real entrypoint uses (in OSS that is
 * `loadExtensions()` + `@blurifycom/core/contracts`; a consumer passes its own).
 */
// Mirrors what the consumer composition root does. See ADR-0025.
export async function bootTestApp(config: BootTestAppConfig): Promise<TestApp> {
  const created = await createApp({
    plugins: config.plugins,
    ...(config.contract ? { contract: config.contract } : {}),
    ...(config.igaming ? { igaming: config.igaming } : {}),
    databaseUrl: config.databaseUrl,
    authSchema: { user, session, account, verification, twoFactor },
    openapi: { enabled: false },
  });

  return {
    app: created.app,
    container: created.container,
    close: created.close,
  };
}
