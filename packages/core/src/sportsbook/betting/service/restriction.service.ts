import { eq } from 'drizzle-orm';
import {
  findOneOrThrow,
  makeNotFoundError,
  type AdminCaller,
  type DrizzleService,
  type DrizzleTx,
  type EventBus,
} from '@openora/core/server';
import type { AuditWritePort, IdentityReader, User } from '@openora/core/contracts';
import type { SportsbookRestriction } from '../contract/index.js';
import { sportsbookPlayerRestriction } from '../schema/index.js';
import { lockPlayer } from './locks.service.js';
import type { SportsbookSessionService } from './session.service.js';

export const SportsbookPlayerNotFoundError = makeNotFoundError('SportsbookPlayer');
const SportsbookRestrictionNotFoundError = makeNotFoundError('SportsbookRestriction');

type RestrictionRow = typeof sportsbookPlayerRestriction.$inferSelect;

function toRestriction(userId: User['id'], row: RestrictionRow | undefined): SportsbookRestriction {
  return {
    userId,
    restricted: row !== undefined,
    reason: row?.reason ?? null,
    createdAt: row?.createdAt.toISOString() ?? null,
  };
}

function changed(before: SportsbookRestriction, after: SportsbookRestriction): boolean {
  return before.restricted !== after.restricted || before.reason !== after.reason;
}

export type SportsbookRestrictionDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  audit: AuditWritePort;
  identity: IdentityReader;
  sessions: SportsbookSessionService;
};

export class SportsbookRestrictionService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly audit: AuditWritePort;
  private readonly identity: IdentityReader;
  private readonly sessions: SportsbookSessionService;

  constructor(deps: SportsbookRestrictionDeps) {
    this.drizzle = deps.drizzle;
    this.events = deps.events;
    this.audit = deps.audit;
    this.identity = deps.identity;
    this.sessions = deps.sessions;
  }

  async get(userId: User['id']): Promise<SportsbookRestriction> {
    await this.assertPlayer(userId);
    const [row] = await this.drizzle.db
      .select()
      .from(sportsbookPlayerRestriction)
      .where(eq(sportsbookPlayerRestriction.userId, userId));
    return toRestriction(userId, row);
  }

  async restrict(
    userId: User['id'],
    reason: string,
    actor: AdminCaller,
  ): Promise<SportsbookRestriction> {
    return this.change({ userId, changeReason: reason, actor }, async (tx, current) => {
      if (current?.reason === reason) {
        return current;
      }
      const rows = await tx
        .insert(sportsbookPlayerRestriction)
        .values({ userId, reason, restrictedBy: actor.userId })
        .onConflictDoUpdate({
          target: sportsbookPlayerRestriction.userId,
          set: { reason, restrictedBy: actor.userId },
        })
        .returning();
      return findOneOrThrow(rows, new SportsbookRestrictionNotFoundError(userId));
    });
  }

  async lift(
    userId: User['id'],
    reason: string,
    actor: AdminCaller,
  ): Promise<SportsbookRestriction> {
    return this.change({ userId, changeReason: reason, actor }, async (tx) => {
      await tx
        .delete(sportsbookPlayerRestriction)
        .where(eq(sportsbookPlayerRestriction.userId, userId));
      return undefined;
    });
  }

  private async change(
    {
      userId,
      changeReason,
      actor,
    }: { userId: User['id']; changeReason: string; actor: AdminCaller },
    apply: (
      tx: DrizzleTx,
      current: RestrictionRow | undefined,
    ) => Promise<RestrictionRow | undefined>,
  ): Promise<SportsbookRestriction> {
    await this.assertPlayer(userId);
    const { after, revoked } = await this.drizzle.db.transaction(async (tx) => {
      await lockPlayer(tx, userId);
      const [current] = await tx
        .select()
        .from(sportsbookPlayerRestriction)
        .where(eq(sportsbookPlayerRestriction.userId, userId));
      const next = toRestriction(userId, await apply(tx, current));
      const revokedIds = next.restricted ? await this.sessions.revokeLive(tx, userId) : [];
      const prior = toRestriction(userId, current);
      if (!changed(prior, next)) {
        return { after: next, revoked: revokedIds };
      }
      await this.audit.recordInTransaction(tx, {
        actorId: actor.userId,
        actorType: 'admin',
        action: 'sportsbook.restriction.changed',
        resourceType: 'sportsbook_player_restriction',
        resourceId: userId,
        before: prior,
        after: { ...next, changeReason, revokedSessions: revokedIds.length },
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
      await this.events.emitInTransaction(tx, 'sportsbook.restriction.changed', {
        userId,
        restricted: next.restricted,
        reason: next.reason,
        actorId: actor.userId,
        ip: actor.ip,
        userAgent: actor.userAgent,
        auditRecorded: true,
      });
      return { after: next, revoked: revokedIds };
    });

    await this.sessions.revokeAtProvider(userId, revoked);
    return after;
  }

  private async assertPlayer(userId: User['id']): Promise<void> {
    if ((await this.identity.getPlayerIdByUserId(userId)) === null) {
      throw new SportsbookPlayerNotFoundError(userId);
    }
  }
}
