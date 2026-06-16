/**
 * Framework-agnostic typed client factory for the OSS platform.
 *
 * Wraps `@orpc/openapi-client` against a contract the CALLER supplies. The
 * platform is headless and modular: each consumer (or each `@oss/<domain>/react`
 * package) composes exactly the contract slices its edition enables and passes
 * it here - the SDK never aggregates domains itself (the no-core-to-domain
 * boundary). Returns a client whose method-and-argument types are inferred from
 * each route's Zod input/output schemas - no manual `client.get` strings.
 *
 * ```ts
 * import { createClient } from '@oss/core/react';
 * import { composeContract } from '../contracts/orpc/index.js';
 * import { gamingContract } from '@oss/core/casino/contracts/gaming';
 *
 * const contract = composeContract({ gaming: gamingContract });
 * const client = createClient(contract, { baseUrl: 'http://localhost:3001' });
 * const games = await client.gaming.listGames();
 * ```
 *
 * Cookies are forwarded by default (`credentials: 'include'`), matching the
 * platform's cookie-based auth. Override `fetch` to customize.
 */

import type { AnyContractRouter, ContractRouterClient } from '@orpc/contract';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { createORPCClient } from '@orpc/client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';

export type OssClient<TContract extends AnyContractRouter> = JsonifiedClient<
  ContractRouterClient<TContract>
>;

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

export function createClient<TContract extends AnyContractRouter>(
  contract: TContract,
  options: CreateClientOptions,
): OssClient<TContract> {
  const link = new OpenAPILink(contract, {
    url: options.baseUrl,
    fetch: options.fetch ?? defaultFetch,
    ...(options.headers ? { headers: options.headers } : {}),
  });

  return createORPCClient(link) as OssClient<TContract>;
}
