import { createToken, type Token } from './token.js';
import type { KycStatus, Player } from '../schemas/player.js';
import type { UserRole } from '../schemas/iam.js';
import type { ClientMeta } from '../schemas/common.js';
import type { SortOrder } from '../kit.js';

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
  staffOnly?: boolean;
  sortBy?: AdminUserSortBy;
  sortOrder?: SortOrder;
};

export type PlayerIdSearchOptions = {
  excludeUserIds?: readonly string[];
  playerOnly?: boolean;
};

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
  update(
    id: string,
    patch: { isActive?: boolean; role?: UserRole },
    actorId: string,
    meta?: ClientMeta,
    options?: {
      beforeWrite?: (tx: unknown, current: { isActive: boolean; role: string }) => Promise<void>;
    },
  ): Promise<AdminUserRow | null>;
  lookupPlayers(userIds: readonly string[]): Promise<AdminPlayerSummary[]>;
  findPlayerIds(query: string, limit?: number, options?: PlayerIdSearchOptions): Promise<string[]>;
  findUserIdsByKycStatus(status: KycStatus, limit?: number): Promise<string[]>;
  getPlayerByUsername(username: string): Promise<AdminPlayerSummary | null>;
};

export const ADMIN_USER_DIRECTORY: Token<AdminUserDirectory> = createToken('ADMIN_USER_DIRECTORY');
