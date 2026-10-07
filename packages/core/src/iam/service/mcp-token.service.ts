import { ORPCError } from '@orpc/server';
import { DatabaseError } from 'pg';
import {
  DrizzleService,
  assertRateLimit,
  createDomainError,
  createLogger,
  findOneOrThrow,
  likeContains,
  makeConflictError,
  makeNotFoundError,
  pageToOffset,
  serializeRow,
  type DrizzleTx,
  type EventBus,
} from '@openora/core/server';
import {
  and,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  RATE_LIMIT_KEYS,
  makeRateLimitKey,
  type AuditWritePort,
  type ClientMeta,
  type McpTokenRevocation,
  type McpTokenRevokeReason,
  type McpTransportConfig,
  type RateLimiterAdapter,
  type RateLimitKey,
  type SortOrder,
  type User,
} from '@openora/core/contracts';
// Read-only cross-domain schema import (sanctioned): token lists show the owning admin, and
// issuance locks the owner's row to check its standing.
import { user } from '@openora/core/pam/schema/identity';
import { mcpToken, type McpToken } from '../schema/index.js';
import {
  McpTokenErrorReasonSchema,
  type CreateMcpTokenInput,
  type ListMcpTokensInput,
  type ListMyMcpTokensInput,
  type McpTokenStatus,
} from '../contract/mcp-token.js';
import {
  generateMcpToken,
  hashMcpToken,
  mcpTokenDisplayPrefix,
  mcpTokenStatus,
} from '../shared/mcp-token.js';

const logger = createLogger('mcp-token-service');

export const McpTokenNotFoundError = makeNotFoundError('McpToken');
export const McpTokenTtlError = createDomainError<[maxDays: number]>(
  'McpTokenTtlError',
  (maxDays) => `An MCP token may live at most ${maxDays} days`,
  { reason: McpTokenErrorReasonSchema.enum.ttl_exceeds_max },
);
export const McpTransportDisabledError = makeConflictError(
  'McpTransportDisabledError',
  'The MCP transport is disabled',
  { reason: McpTokenErrorReasonSchema.enum.mcp_disabled },
);
export const McpTokenOwnerIneligibleError = createDomainError(
  'McpTokenOwnerIneligibleError',
  () => 'This account may not hold an MCP token',
  { reason: McpTokenErrorReasonSchema.enum.owner_ineligible },
);
export const McpTokenLimitError = createDomainError<[maxActive: number]>(
  'McpTokenLimitError',
  (maxActive) => `An admin may hold at most ${maxActive} active MCP tokens`,
  { reason: McpTokenErrorReasonSchema.enum.token_limit },
);
export const McpTokenIssueError = createDomainError(
  'McpTokenIssueError',
  () => 'The MCP token could not be issued',
);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
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

const ISSUANCE_REFUSALS = [McpTokenOwnerIneligibleError, McpTokenLimitError, ORPCError] as const;

export type McpTokenServiceDeps = {
  drizzle: DrizzleService;
  audit: AuditWritePort;
  events: EventBus;
  rateLimiter: RateLimiterAdapter<RateLimitKey>;
  config: McpTransportConfig;
  now?: (() => Date) | undefined;
};

type RevocationActor = { actorId: User['id'] | null } & Partial<ClientMeta>;

type UsersRevocation = Omit<Parameters<McpTokenRevocation['revokeAllForUser']>[0], 'userId'> & {
  userIds: readonly User['id'][];
};

function toMcpTokenDto(row: McpToken, now: Date) {
  const { tokenHash: _tokenHash, ...token } = row;
  return { ...serializeRow(token, { dateFields: DATE_FIELDS }), status: mcpTokenStatus(row, now) };
}

function auditClientMeta(meta: Partial<ClientMeta>) {
  return { ip: meta.ip ?? null, userAgent: meta.userAgent ?? null };
}

function nullsLast(column: AnyPgColumn, order: SortOrder) {
  return order === 'asc' ? sql`${column} asc nulls last` : sql`${column} desc nulls last`;
}

function sqlState(err: unknown) {
  return err instanceof DatabaseError ? err.code : undefined;
}

/** What a failed issuance may log: a query error's message and cause carry the token hash. */
function failureSignature(err: unknown) {
  if (!(err instanceof Error)) {
    return { name: typeof err, code: null };
  }
  return { name: err.constructor.name, code: sqlState(err) ?? sqlState(err.cause) ?? null };
}

function sanitizeIssuanceFailure(err: unknown) {
  if (ISSUANCE_REFUSALS.some((refusal) => err instanceof refusal)) {
    return err;
  }
  logger.error(failureSignature(err), 'MCP token issuance failed');
  return new McpTokenIssueError();
}

/**
 * Issues, lists and revokes the bearer tokens an admin's MCP client authenticates with. Only a
 * token's SHA-256 hash is stored; the plaintext leaves this service once, from `create`.
 */
export class McpTokenService implements McpTokenRevocation {
  private readonly drizzle: DrizzleService;
  private readonly audit: AuditWritePort;
  private readonly events: EventBus;
  private readonly rateLimiter: RateLimiterAdapter<RateLimitKey>;
  private readonly config: McpTransportConfig;
  private readonly now: () => Date;

  constructor({ drizzle, audit, events, rateLimiter, config, now }: McpTokenServiceDeps) {
    this.drizzle = drizzle;
    this.audit = audit;
    this.events = events;
    this.rateLimiter = rateLimiter;
    this.config = config;
    this.now = now ?? (() => new Date());
  }

  /**
   * Refuses a disabled transport, a lifetime over the cap, an owner who is missing, inactive or
   * a player, an owner at the active-token cap, and an owner over the hourly issuance limit (a
   * 429 carrying `retryAfterMs`). Any other failure surfaces as `McpTokenIssueError`.
   */
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
    const created = await this.drizzle.db
      .transaction(async (tx) => {
        await this.assertOwnerMayIssue(tx, { ownerId: adminUserId, meta, now: createdAt });
        await assertRateLimit(
          this.rateLimiter,
          makeRateLimitKey(RATE_LIMIT_KEYS.MCP_TOKEN_CREATE, adminUserId),
          { limit: this.config.tokenIssuance.perHour, windowMs: HOUR_MS, onUnavailable: 'deny' },
        );
        return this.insertToken(tx, { adminUserId, label, token, createdAt, lifetimeDays, meta });
      })
      .catch((err: unknown) => {
        throw sanitizeIssuanceFailure(err);
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
        .orderBy(
          nullsLast(SORT_COLUMNS[sortBy ?? 'createdAt'], sortOrder ?? 'desc'),
          desc(mcpToken.id),
        )
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
    return this.revokeActive({
      scope: undefined,
      reason: 'revoked_all',
      actor: { ...meta, actorId },
    });
  }

  revokeAllForUser(
    { userId, ...revocation }: Parameters<McpTokenRevocation['revokeAllForUser']>[0],
    tx?: unknown,
  ) {
    return this.revokeAllForUsers(
      { ...revocation, userIds: [userId] },
      tx === undefined ? undefined : (tx as DrizzleTx),
    );
  }

  /** Runs inside `tx` when one is given, so the revocation commits or rolls back with it. */
  async revokeAllForUsers({ userIds, reason, ...actor }: UsersRevocation, tx?: DrizzleTx) {
    if (userIds.length === 0) {
      return { revoked: 0 };
    }
    return this.revokeActive(
      { scope: inArray(mcpToken.adminUserId, [...userIds]), reason, actor },
      tx,
    );
  }

  /**
   * Postgres' SHARE ROW EXCLUSIVE waits for every transaction that has inserted a token to
   * commit, and conflicts with itself: a bulk revocation holding it sees every token issued
   * before it, and concurrent bulk revocations run one after another.
   */
  async lockForRevocation(tx: DrizzleTx) {
    await tx.execute(sql`LOCK TABLE ${mcpToken} IN SHARE ROW EXCLUSIVE MODE`);
  }

  private async assertOwnerMayIssue(
    tx: DrizzleTx,
    { ownerId, meta, now }: { ownerId: User['id']; meta: ClientMeta; now: Date },
  ) {
    const [owner] = await tx
      .select({ isActive: user.isActive, role: user.role })
      .from(user)
      .where(eq(user.id, ownerId))
      .for('no key update');
    if (!owner?.isActive || owner.role === 'player') {
      this.emitOwnerIneligible(ownerId, owner?.role, meta);
      throw new McpTokenOwnerIneligibleError();
    }
    const [active] = await tx
      .select({ n: count() })
      .from(mcpToken)
      .where(and(eq(mcpToken.adminUserId, ownerId), STATUS_FILTERS.active(now)));
    const { maxActivePerAdmin } = this.config.tokenIssuance;
    if (Number(active?.n ?? 0) >= maxActivePerAdmin) {
      throw new McpTokenLimitError(maxActivePerAdmin);
    }
  }

  private async insertToken(
    tx: DrizzleTx,
    {
      adminUserId,
      label,
      token,
      createdAt,
      lifetimeDays,
      meta,
    }: {
      adminUserId: User['id'];
      label: McpToken['label'];
      token: string;
      createdAt: Date;
      lifetimeDays: number;
      meta: ClientMeta;
    },
  ) {
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
  }

  private emitOwnerIneligible(ownerId: User['id'], role: string | undefined, meta: ClientMeta) {
    this.events.emit('identity.user.unauthorized_access', {
      userId: ownerId,
      playerId: null,
      resource: 'mcp-access',
      action: 'use',
      ip: meta.ip,
      userAgent: meta.userAgent,
      role,
    });
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
    {
      scope,
      reason,
      actor,
    }: { scope: SQL | undefined; reason: McpTokenRevokeReason; actor: RevocationActor },
    tx?: DrizzleTx,
  ) {
    const now = this.now();
    const revoke = async (inTx: DrizzleTx) => {
      await this.lockForRevocation(inTx);
      return this.markRevoked(inTx, {
        scope: and(scope, gt(mcpToken.expiresAt, now)),
        reason,
        actor,
        now,
      });
    };
    const revoked = tx ? await revoke(tx) : await this.drizzle.db.transaction(revoke);
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
