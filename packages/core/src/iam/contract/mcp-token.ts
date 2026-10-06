import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  MCP_TOKEN_TTL_CEILING_DAYS,
  McpTokenRevokeReasonSchema,
  TimestampSchema,
  UuidSchema,
} from '@openora/core/contracts';
import { PageQuerySchema, SortOrderSchema, paginated } from '@openora/core/contracts/kit';

export { McpTokenRevokeReasonSchema } from '@openora/core/contracts';

export const MCP_TOKEN_STATUSES = ['active', 'expired', 'revoked'] as const;
export const McpTokenStatusSchema = z.enum(MCP_TOKEN_STATUSES);
export type McpTokenStatus = z.infer<typeof McpTokenStatusSchema>;

export const MCP_TOKEN_SORT_BY_VALUES = [
  'createdAt',
  'expiresAt',
  'lastUsedAt',
  'callCount',
] as const;
export const McpTokenSortBySchema = z.enum(MCP_TOKEN_SORT_BY_VALUES).default('createdAt');
export type McpTokenSortBy = z.infer<typeof McpTokenSortBySchema>;

export const McpTokenSchema = z.object({
  id: UuidSchema,
  label: z.string(),
  tokenPrefix: z.string(),
  adminUserId: UuidSchema,
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  lastUsedAt: TimestampSchema.nullable(),
  callCount: z.number().int(),
  status: McpTokenStatusSchema,
  revokedAt: TimestampSchema.nullable(),
  revokedBy: UuidSchema.nullable(),
  revokeReason: McpTokenRevokeReasonSchema.nullable(),
});

// Every field but the id is null once the admin's account no longer exists.
export const McpTokenAdminSchema = z.object({
  id: UuidSchema,
  email: z.string().nullable(),
  name: z.string().nullable(),
  isActive: z.boolean().nullable(),
});

export const McpTokenListItemSchema = McpTokenSchema.extend({ admin: McpTokenAdminSchema });

/** The only response that carries the plaintext token; it cannot be read back afterwards. */
export const IssuedMcpTokenSchema = McpTokenSchema.extend({ token: z.string() });

export const CreateMcpTokenInputSchema = z.object({
  label: z.string().trim().min(1).max(64),
  ttlDays: z.number().int().min(1).max(MCP_TOKEN_TTL_CEILING_DAYS).optional(),
});

export const ListMyMcpTokensInputSchema = PageQuerySchema.extend({
  status: McpTokenStatusSchema.optional(),
  sortBy: McpTokenSortBySchema.optional(),
  sortOrder: SortOrderSchema.default('desc').optional(),
});

export const ListMcpTokensInputSchema = ListMyMcpTokensInputSchema.extend({
  adminUserId: UuidSchema.optional(),
  search: z.string().trim().min(1).max(100).optional(),
});

export const McpTokenIdInputSchema = z.object({ tokenId: UuidSchema });

export const RevokeAllMcpTokensOutputSchema = z.object({ revoked: z.number().int() });

export const mcpTokenContract = {
  create: oc
    .route({ method: 'POST', path: '/iam/my-mcp-tokens' })
    .input(CreateMcpTokenInputSchema)
    .output(IssuedMcpTokenSchema),

  listMine: oc
    .route({ method: 'GET', path: '/iam/my-mcp-tokens' })
    .input(ListMyMcpTokensInputSchema)
    .output(paginated(McpTokenListItemSchema)),

  revokeMine: oc
    .route({ method: 'POST', path: '/iam/my-mcp-tokens/{tokenId}/revoke' })
    .input(McpTokenIdInputSchema)
    .output(McpTokenSchema),

  list: oc
    .route({ method: 'GET', path: '/iam/mcp-tokens' })
    .input(ListMcpTokensInputSchema)
    .output(paginated(McpTokenListItemSchema)),

  revoke: oc
    .route({ method: 'POST', path: '/iam/mcp-tokens/{tokenId}/revoke' })
    .input(McpTokenIdInputSchema)
    .output(McpTokenSchema),

  revokeAll: oc
    .route({ method: 'POST', path: '/iam/mcp-tokens/revoke-all' })
    .output(RevokeAllMcpTokensOutputSchema),
};

export type McpToken = z.infer<typeof McpTokenSchema>;
export type McpTokenListItem = z.infer<typeof McpTokenListItemSchema>;
export type IssuedMcpToken = z.infer<typeof IssuedMcpTokenSchema>;
export type CreateMcpTokenInput = z.infer<typeof CreateMcpTokenInputSchema>;
export type ListMyMcpTokensInput = z.infer<typeof ListMyMcpTokensInputSchema>;
export type ListMcpTokensInput = z.infer<typeof ListMcpTokensInputSchema>;
