import { createToken, type Token } from './token.js';
import type { KycStatus, Player } from '../schemas/player.js';
import type { UserRole } from '../schemas/iam.js';
import type { ClientMeta } from '../schemas/common.js';
import type { SortOrder } from '../kit.js';

/**
 * Admin/back-office view of the user directory. Owned + bound by the identity
 * module (it owns the `user` table); the back-office (admin-console) depends only
 * on this port, never on the identity schema, so it stays a clean, extractable
 * module. A query/command port like WALLET_COMMANDS. See ADR-0017/0025.
 */

export type AdminUserRow = {
  id: string;
  email: string;
  name: string | null;
  createdAt: Date;
  isActive: boolean;
  role: string;
  language: string | null;
  failedLoginAttempts?: number;
  lockoutUntil?: Date | null;
};

export const ADMIN_USER_SORT_BY_VALUES = [
  'createdAt',
  'email',
  'name',
  'role',
  'isActive',
  'lastLockoutAt',
] as const;
export type AdminUserSortBy = (typeof ADMIN_USER_SORT_BY_VALUES)[number];

export type AdminUserListOptions = {
  page: number;
  limit: number;
  search?: string;
  sortBy?: AdminUserSortBy;
  sortOrder?: SortOrder;
};

/**
 * Player-facing back-office enrichment (username + KYC). Lets a back-office
 * consumer label a player row without reaching into the player/profile tables.
 */
export type AdminPlayerSummary = {
  playerId: Player['id'];
  userId: string;
  username: string;
  email: string;
  kycStatus: KycStatus | null;
  language: string | null;
  avatarUrl: string | null;
  createdAt: Date;
  level: number;
  currency: string;
};

export type AdminUserDirectory = {
  count(): Promise<number>;
  list(opts: AdminUserListOptions): Promise<{ rows: AdminUserRow[]; total: number }>;
  get(id: string): Promise<AdminUserRow | null>;
  lookupUsers(userIds: readonly string[]): Promise<AdminUserRow[]>;
  /** actorId = the admin performing the change (for audit attribution on an isActive flip). */
  update(
    id: string,
    patch: { isActive?: boolean; role?: UserRole },
    actorId: string,
    meta?: ClientMeta,
  ): Promise<AdminUserRow | null>;
  /**
   * Batch enrichment for back-office lists (eg the withdrawal queue). Returns one
   * entry per resolvable id; unknown ids are omitted.
   */
  lookupPlayers(userIds: readonly string[]): Promise<AdminPlayerSummary[]>;
  /**
   * Resolves a free-text player filter to a capped set of userIds, matched against
   * email or the identity-owned username. Empty = all candidates.
   * limit caps both sub-queries and the merged set; defaults to 1000 (the implementation cap).
   */
  findPlayerIds(query: string, limit?: number): Promise<string[]>;
  /**
   * Exact-match resolution by display name (case-insensitive) - for callers that
   * already have a complete, known username (not a partial search term), eg chat
   * commands' /donate, /block, /ignore. Distinct from findPlayerIds' capped fuzzy
   * substring search: a short/common username can substring-collide with more than
   * the 20-row cap of unrelated accounts and silently drop the real exact match.
   */
  getPlayerByUsername(username: string): Promise<AdminPlayerSummary | null>;
};

export const ADMIN_USER_DIRECTORY: Token<AdminUserDirectory> = createToken('ADMIN_USER_DIRECTORY');
