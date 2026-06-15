'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

export type QueryValue = string | number | boolean | undefined | null;
export type QueryParams = Record<string, QueryValue>;

export type OssApiClient = {
  baseUrl: string;
  get: <T = unknown>(path: string, query?: QueryParams) => Promise<T>;
  post: <T = unknown>(path: string, body?: unknown) => Promise<T>;
  patch: <T = unknown>(path: string, body?: unknown) => Promise<T>;
  delete: <T = unknown>(path: string) => Promise<T>;
};

export type OssApiClientConfig = {
  baseUrl: string;
};

const ApiClientContext = createContext<OssApiClient | null>(null);

function buildQueryString(query?: QueryParams): string {
  if (!query) return '';
  const entries = Object.entries(query).filter(
    ([, v]) => v !== undefined && v !== null && v !== '',
  );
  if (entries.length === 0) return '';
  const params = new URLSearchParams();
  for (const [k, v] of entries) params.set(k, String(v));
  return `?${params.toString()}`;
}

function buildClient(config: OssApiClientConfig | OssApiClient): OssApiClient {
  if ('get' in config && 'post' in config && 'patch' in config) return config;
  const baseUrl = config.baseUrl;
  const send = async <T,>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> => {
    const init: RequestInit = { method, credentials: 'include' };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${baseUrl}${path}`, init);
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  };
  return {
    baseUrl,
    get: (path, query) => send('GET', `${path}${buildQueryString(query)}`),
    post: (path, body) => send('POST', path, body),
    patch: (path, body) => send('PATCH', path, body),
    delete: (path) => send('DELETE', path),
  };
}

export function ApiClientProvider({
  client,
  children,
}: {
  client: OssApiClient | OssApiClientConfig;
  children: ReactNode;
}) {
  const value = useMemo(() => buildClient(client), [client]);
  return <ApiClientContext.Provider value={value}>{children}</ApiClientContext.Provider>;
}

export function useApiClient(): OssApiClient {
  const ctx = useContext(ApiClientContext);
  if (!ctx) throw new Error('useApiClient must be used within ApiClientProvider');
  return ctx;
}
