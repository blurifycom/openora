// Server-side data fetchers for the public player pages.
//
// These run on the server only - inside a Next.js RSC (async server component).
// They build a typed oRPC client via @oss/sdk-core (plain fetch, no React)
// against the internal API URL and forward the incoming request headers
// (cookies) so the call is made as the current player. The result is handed
// to the matching player page as `initialData`, so the first paint is
// server-rendered and react-query hydrates from it on the client. No
// `'use client'` here; nothing in this file is bundled into the browser.

import type { z } from 'zod';
import { LobbyCategorySchema, FeaturedSlotSchema, GameSchema } from '@oss/orpc-contract';
import { createClient } from '@oss/sdk-core';

export type LobbyCategory = z.infer<typeof LobbyCategorySchema>;
export type FeaturedSlot = z.infer<typeof FeaturedSlotSchema>;
export type Game = z.infer<typeof GameSchema>;

export type LobbyData = { categories: LobbyCategory[]; featured: FeaturedSlot[] };
export type GamesData = { games: Game[] };

export type ServerFetchOptions = {
  /** Internal API base URL (eg `http://localhost:3101`). No trailing slash. */
  baseUrl: string;
  /** Request headers to forward (cookies, etc) so the call runs as the player. */
  headers?: Record<string, string>;
};

function serverClient(options: ServerFetchOptions) {
  return createClient({
    baseUrl: options.baseUrl,
    ...(options.headers ? { headers: () => options.headers as Record<string, string> } : {}),
  });
}

export async function fetchLobbyData(options: ServerFetchOptions): Promise<LobbyData> {
  const client = serverClient(options);
  const [categories, featured] = await Promise.all([
    client.lobby.listCategories(),
    client.lobby.getFeatured(),
  ]);
  return { categories, featured };
}

export async function fetchGamesData(options: ServerFetchOptions): Promise<GamesData> {
  const client = serverClient(options);
  const games = await client.gaming.listGames();
  return { games };
}

// Note: prefetchers for premium surfaces (sportsbook, leaderboard, ...) intentionally
// do NOT live in the core SDK - the free edition's typed client has no such namespace.
// A consumer that licenses a premium module builds its own prefetcher against the
// merged contract. See ADR-0020.
