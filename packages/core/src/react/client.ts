import type { AnyContractRouter, ContractRouterClient } from '@orpc/contract';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { createORPCClient } from '@orpc/client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';

export type OssClient<TContract extends AnyContractRouter> = JsonifiedClient<
  ContractRouterClient<TContract>
>;

export type CreateClientOptions = {
  baseUrl: string;
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
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
