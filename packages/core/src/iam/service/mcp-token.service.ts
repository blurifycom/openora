import {
  DrizzleService,
  createDomainError,
  findOneOrThrow,
  likeContains,
  makeConflictError,
  makeNotFoundError,
  pageToOffset,
  serializeRow,
  type DrizzleTx,
} from '@openora/core/server';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  isNotNull,
  isNull,
  lte,
  or,
  type SQL,
} from 'drizzle-orm';
import type {
  AuditWritePort,
  ClientMeta,
  McpTokenRevocation,
  McpTokenRevokeReason,
  McpTransportConfig,
  User,
} from '@openora/core/contracts';
// Read-only cross-domain schema import (sanctioned): token lists show the owning admin.
import { user } from '@openora/core/pam/schema/identity';
import { mcpToken, type McpToken } from '../schema/index.js';
import type {
  CreateMcpTokenInput,
  ListMcpTokensInput,
  ListMyMcpTokensInput,
  McpTokenStatus,
} from '../contract/mcp-token.js';
import {
  generateMcpToken,
  hashMcpToken,
  mcpTokenDisplayPrefix,
  mcpTokenStatus,
} from '../shared/mcp-token.js';

export const McpTokenNotFoundError = makeNotFoundError('McpToken');
export const McpTokenTtlError = createDomainError<[maxDays: number]>(
  'McpTokenTtlError',
  (maxDays) => `An MCP token may live at most ${maxDays} days`,
);
export const McpTransportDisabledError = makeConflictError(
  'McpTransportDisabledError',
  'The MCP transport is disabled',
);

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_FIELDS = ['createdAt', 'expiresAt', 'revokedAt', 'lastUsedAt'] as const;

const SORT_COLUMNS = {
  createdAt: mcpToken.createdAt,
  expiresAt: mcpToken.expiresAt,
  lastUsedAt: mcpToken.lastUsedAt,
  callCount: mcpToken.callCount,
} as const;

const STATUS_FILTERS = {
  revoked: () => isNotNull(mcpToken.revokedAt),
  expired: (now: Date) => and(isNull(mcpToken.revokedAt), lte(mcpToken.expiresAt, now)),
  active: (now: Date) => and(isNull(mcpToken.revokedAt), gt(mcpToken.expiresAt, now)),
} satisfies Record<McpTokenStatus, (now: Date) => SQL | undefined>;

export type McpTokenServiceDeps = {
  drizzle: DrizzleService;
  audit: AuditWritePort;
  config: McpTransportConfig;
  now?: (() => Date) | undefined;
};

type RevocationActor = { actorId: User['id'] | null } & Partial<ClientMeta>;

function toMcpTokenDto(row: McpToken, now: Date) {
  const { tokenHash: _tokenHash, ...token } = row;
  return { ...serializeRow(token, { dateFields: DATE_FIELDS }), status: mcpTokenStatus(row, now) };
}

function auditClientMeta(meta: Partial<ClientMeta>) {
  return { ip: meta.ip ?? null, userAgent: meta.userAgent ?? null };
}

/**
 * Issues, lists and revokes the bearer tokens an admin's MCP client authenticates with. Only a
 * token's SHA-256 hash is stored; the plaintext leaves this service once, from `create`.
 */
export class McpTokenService implements McpTokenRevocation {
  private readonly drizzle: DrizzleService;
  private readonly audit: AuditWritePort;
  private readonly config: McpTransportConfig;
  private readonly now: () => Date;

  constructor({ drizzle, audit, config, now }: McpTokenServiceDeps) {
    this.drizzle = drizzle;
    this.audit = audit;
    this.config = config;
    this.now = now ?? (() => new Date());
  }

  async create(
    { adminUserId, label, ttlDays }: CreateMcpTokenInput & { adminUserId: User['id'] },
    meta: ClientMeta,
  ) {
    if (!this.config.enabled) {
      throw new McpTransportDisabledError();
    }
    const lifetimeDays = ttlDays ?? this.config.tokenTtlDays.default;
    if (lifetimeDays > this.config.tokenTtlDays.max) {
      throw new McpTokenTtlError(this.config.tokenTtlDays.max);
    }

    const token = generateMcpToken();
    const createdAt = this.now();
    const created = await this.drizzle.db.transaction(async (tx) => {
      const row = findOneOrThrow(
        await tx
          .insert(mcpToken)
          .values({
            adminUserId,
            label,
            tokenHash: hashMcpToken(token),
            tokenPrefix: mcpTokenDisplayPrefix(token),
            createdAt,
            expiresAt: new Date(createdAt.getTime() + lifetimeDays * DAY_MS),
          })
          .returning(),
        new McpTokenNotFoundError(adminUserId),
      );
      await this.audit.recordInTransaction(tx, {
        ...auditClientMeta(meta),
        actorId: adminUserId,
        actorType: 'admin',
        action: 'iam.mcp_token.created',
        resourceType: 'mcp-token',
        resourceId: row.id,
        after: {
          adminUserId,
          label: row.label,
          tokenPrefix: row.tokenPrefix,
          expiresAt: row.expiresAt.toISOString(),
          ttlDays: lifetimeDays,
        },
      });
      return row;
    });
    return { ...toMcpTokenDto(created, createdAt), token };
  }

  listMine(adminUserId: User['id'], query: ListMyMcpTokensInput) {
    return this.list({ ...query, adminUserId });
  }

  async list({ adminUserId, search, status, page, limit, sortBy, sortOrder }: ListMcpTokensInput) {
    const now = this.now();
    const where = and(
      adminUserId ? eq(mcpToken.adminUserId, adminUserId) : undefined,
      status ? STATUS_FILTERS[status](now) : undefined,
      search
        ? or(ilike(mcpToken.label, likeContains(search)), ilike(user.email, likeContains(search)))
        : undefined,
    );
    const dir = (sortOrder ?? 'desc') === 'asc' ? asc : desc;
    const db = this.drizzle.db;
    const [rows, [totals]] = await Promise.all([
      db
        .select({
          token: mcpToken,
          adminEmail: user.email,
          adminName: user.name,
          adminIsActive: user.isActive,
        })
        .from(mcpToken)
        .leftJoin(user, eq(user.id, mcpToken.adminUserId))
        .where(where)
        .orderBy(dir(SORT_COLUMNS[sortBy ?? 'createdAt']), desc(mcpToken.id))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      db
        .select({ n: count() })
        .from(mcpToken)
        .leftJoin(user, eq(user.id, mcpToken.adminUserId))
        .where(where),
    ]);
    return {
      items: rows.map(({ token, adminEmail, adminName, adminIsActive }) => ({
        ...toMcpTokenDto(token, now),
        admin: {
          id: token.adminUserId,
          email: adminEmail,
          name: adminName,
          isActive: adminIsActive,
        },
      })),
      total: Number(totals?.n ?? 0),
      page,
      limit,
    };
  }

  /**
   * Another admin's token answers exactly like an unknown one, so the owner route cannot be used
   * to probe which token ids exist.
   */
  revokeMine(adminUserId: User['id'], tokenId: McpToken['id'], meta: ClientMeta) {
    return this.revokeOne({ tokenId, ownerId: adminUserId }, { ...meta, actorId: adminUserId });
  }

  revoke(tokenId: McpToken['id'], actorId: User['id'], meta: ClientMeta) {
    return this.revokeOne({ tokenId }, { ...meta, actorId });
  }

  revokeAll(actorId: User['id'], meta: ClientMeta) {
    return this.revokeActive(undefined, 'revoked_all', { ...meta, actorId });
  }

  revokeAllForUser({
    userId,
    reason,
    ...actor
  }: Parameters<McpTokenRevocation['revokeAllForUser']>[0]) {
    return this.revokeActive(eq(mcpToken.adminUserId, userId), reason, actor);
  }

  private async revokeOne(
    { tokenId, ownerId }: { tokenId: McpToken['id']; ownerId?: User['id'] },
    actor: RevocationActor,
  ) {
    const scope = and(
      eq(mcpToken.id, tokenId),
      ownerId ? eq(mcpToken.adminUserId, ownerId) : undefined,
    );
    const now = this.now();
    const row = await this.drizzle.db.transaction(async (tx) => {
      const [revoked] = await this.markRevoked(tx, { scope, reason: 'manual', actor, now });
      if (revoked) {
        return revoked;
      }
      return findOneOrThrow(
        await tx.select().from(mcpToken).where(scope),
        new McpTokenNotFoundError(tokenId),
      );
    });
    return toMcpTokenDto(row, now);
  }

  private async revokeActive(
    scope: SQL | undefined,
    reason: McpTokenRevokeReason,
    actor: RevocationActor,
  ) {
    const now = this.now();
    const revoked = await this.drizzle.db.transaction((tx) =>
      this.markRevoked(tx, {
        scope: and(scope, gt(mcpToken.expiresAt, now)),
        reason,
        actor,
        now,
      }),
    );
    return { revoked: revoked.length };
  }

  private async markRevoked(
    tx: DrizzleTx,
    {
      scope,
      reason,
      actor,
      now,
    }: { scope: SQL | undefined; reason: McpTokenRevokeReason; actor: RevocationActor; now: Date },
  ) {
    const revoked = await tx
      .update(mcpToken)
      .set({ revokedAt: now, revokedBy: actor.actorId, revokeReason: reason })
      .where(and(scope, isNull(mcpToken.revokedAt)))
      .returning();
    for (const row of revoked) {
      await this.audit.recordInTransaction(tx, {
        ...auditClientMeta(actor),
        actorId: actor.actorId,
        actorType: actor.actorId ? 'admin' : 'system',
        action: 'iam.mcp_token.revoked',
        resourceType: 'mcp-token',
        resourceId: row.id,
        before: { revokedAt: null },
        after: {
          adminUserId: row.adminUserId,
          label: row.label,
          tokenPrefix: row.tokenPrefix,
          reason,
        },
      });
    }
    return revoked;
  }
}
