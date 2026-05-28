/**
 * @oss/sdk-core - framework-agnostic typed client for the OSS platform.
 *
 * Wraps `@orpc/openapi-client` against the published `contract` from
 * `@oss/orpc-contract`. Returns a client with method-and-argument types
 * inferred from each route's Zod input/output schemas - no manual `client.get`
 * strings, no response casts. No React: framework SDKs (react-hooks, a future
 * svelte-sdk) wrap this with their own bindings.
 *
 * ```ts
 * import { createClient } from '@oss/sdk-core';
 *
 * const client = createClient({ baseUrl: 'http://localhost:3001' });
 *
 * const stats = await client.backoffice.getStats();                 // PlatformStats
 * const { users } = await client.backoffice.listUsers({ page: 1 });
 * const games = await client.gaming.listGames();
 * ```
 *
 * Cookies are forwarded by default (`credentials: 'include'`), matching the
 * platform's cookie-based auth. Override `fetch` to customize.
 */

import type { ContractRouterClient } from '@orpc/contract';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { createORPCClient } from '@orpc/client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { contract } from '@oss/orpc-contract';

export type OssClient = JsonifiedClient<ContractRouterClient<typeof contract>>;

export type CreateClientOptions = {
  /** Base URL of the API (eg `http://localhost:3001`). No trailing slash. */
  baseUrl: string;
  /** Extra headers applied to every request. May return a Promise. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Override `fetch`. Default forwards cookies via `credentials: 'include'`. */
  fetch?: typeof globalThis.fetch;
};

const defaultFetch: typeof globalThis.fetch = (request, init) =>
  globalThis.fetch(request, { ...init, credentials: 'include' });

export function createClient(options: CreateClientOptions): OssClient {
  const link = new OpenAPILink(contract, {
    url: options.baseUrl,
    fetch: options.fetch ?? defaultFetch,
    ...(options.headers ? { headers: options.headers } : {}),
  });

  return createORPCClient(link) as OssClient;
}

export { contract } from '@oss/orpc-contract';
