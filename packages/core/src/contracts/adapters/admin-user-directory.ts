import { createToken, type Token } from './token.js';
import type { KycStatus } from '../schemas/player.js';
import type { UserRole } from '../schemas/iam.js';

// Admin/back-office view of the user directory. Owned + bound by the identity
// module (it owns the `user` table); the back-office (admin-console) depends only
// on this port, never on the identity schema, so it stays a clean, extractable
// module. A query/command port like WALLET_COMMANDS. See ADR-0017/0025.

export type AdminUserRow = {
  id: string;
  email: string;
  name: string | null;
  createdAt: Date;
  isActive: boolean;
  role: UserRole;
  failedLoginAttempts?: number;
  lockoutUntil?: Date | null;
};

export type AdminUserListOptions = { page: number; limit: number; search?: string };

// Player-facing back-office enrichment (username + KYC). Lets a back-office
// consumer label a player row without reaching into the player/profile tables.
export type AdminPlayerSummary = {
  userId: string;
  username: string;
  email: string;
  kycStatus: KycStatus | null;
};

export type AdminUserDirectory = {
  count(): Promise<number>;
  list(opts: AdminUserListOptions): Promise<{ rows: AdminUserRow[]; total: number }>;
  get(id: string): Promise<AdminUserRow | null>;
  // actorId = the admin performing the change (for audit attribution on an isActive flip).
  update(
    id: string,
    patch: { isActive?: boolean; role?: UserRole },
    actorId: string,
    meta?: { ip?: string | null; userAgent?: string | null },
  ): Promise<AdminUserRow | null>;
  // Batch enrichment for back-office lists (eg the withdrawal queue). Returns one
  // entry per resolvable id; unknown ids are omitted.
  lookupPlayers(userIds: readonly string[]): Promise<AdminPlayerSummary[]>;
  // Resolves a free-text player filter to a capped set of userIds, matched against
  // email (user table) OR username/displayName (player table). Empty = no match.
  findPlayerIds(query: string): Promise<string[]>;
};

export const ADMIN_USER_DIRECTORY: Token<AdminUserDirectory> = createToken('ADMIN_USER_DIRECTORY');
