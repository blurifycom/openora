import { createToken, type Token } from './token.js';

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
  role: string;
};

export type AdminUserListOptions = { page: number; limit: number; search?: string };

export type AdminUserDirectory = {
  count(): Promise<number>;
  list(opts: AdminUserListOptions): Promise<{ rows: AdminUserRow[]; total: number }>;
  get(id: string): Promise<AdminUserRow | null>;
  // actorId = the admin performing the change (for audit attribution on an isActive flip).
  update(
    id: string,
    patch: { isActive?: boolean; role?: string },
    actorId: string,
  ): Promise<AdminUserRow | null>;
};

export const ADMIN_USER_DIRECTORY: Token<AdminUserDirectory> = createToken('ADMIN_USER_DIRECTORY');
