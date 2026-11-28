import * as z from 'zod';
import { createToken, type Token } from './token.js';
import { UuidSchema } from '../schemas/common.js';

export type AdminGrant = { resource: string; action: string };

export type AdminPermissionResolver = {
  getGrants(userId: string): Promise<AdminGrant[]>;
  isSuperAdmin(userId: string): Promise<boolean>;
};

export const ADMIN_PERMISSION_RESOLVER: Token<AdminPermissionResolver> = createToken(
  'ADMIN_PERMISSION_RESOLVER',
);

export const ADMIN_PERMISSION_ROUTES = {
  grants: '/iam/admin-permissions/grants',
  superAdmin: '/iam/admin-permissions/super-admin',
} as const;

export const AdminPermissionWire = {
  grants: {
    input: z.object({ userId: UuidSchema }),
    output: z.object({ grants: z.array(z.object({ resource: z.string(), action: z.string() })) }),
  },
  superAdmin: {
    input: z.object({ userId: UuidSchema }),
    output: z.object({ isSuperAdmin: z.boolean() }),
  },
} as const;
