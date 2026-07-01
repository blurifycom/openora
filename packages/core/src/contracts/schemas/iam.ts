import * as z from 'zod';

export const permissionLevels = ['no_access', 'read', 'read_write'] as const;
export const PermissionLevelSchema = z.enum(permissionLevels);
export type PermissionLevel = z.infer<typeof PermissionLevelSchema>;
