// Server-only helpers for route loaders. These run during SSR (and on client
// navigations that hit the server). They call the @oss/react-sdk/server fetchers
// against the INTERNAL API URL and forward the incoming request cookies so the
// call is made as the current player. Nothing here is bundled into the browser.

import { getWebRequest } from '@tanstack/react-start/server';
import type { ServerFetchOptions } from '@oss/react-sdk/server';

// Internal (server-to-server) API URL. Falls back to the public default.
const INTERNAL_API_URL =
  process.env.INTERNAL_API_URL ?? process.env.VITE_PUBLIC_API_URL ?? 'http://localhost:3001';

// Build the options for an @oss/react-sdk/server fetcher: internal base URL +
// the incoming cookie header (so the API sees the player's session).
export function serverFetchOptions(): ServerFetchOptions {
  const request = getWebRequest();
  const cookie = request?.headers.get('cookie');
  return {
    baseUrl: INTERNAL_API_URL,
    ...(cookie ? { headers: { cookie } } : {}),
  };
}
