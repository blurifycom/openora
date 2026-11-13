import { and, asc, eq, ne, or, sql } from 'drizzle-orm';
import {
  auditOutbox,
  type DrizzleDb,
  type DrizzleService,
  type DrizzleTx,
} from '@openora/core/server';
import type { AuditEmailChange, AuditReader, AuditSubject } from '@openora/core/contracts';
import { auditLog } from '../schema/index.js';

const EMAIL_CHANGED = 'identity.email.changed';

type Change = AuditEmailChange & { eventId: string | null };

// ponytail: seq scan of the outbox, fine while the shipper keeps it near empty; if a stalled
// shipper makes these reads slow, add a partial index on (entry->>'resourceId') for email changes.
// The key goes in as a literal so such an expression index can match.
const queuedField = (key: 'action' | 'resourceType' | 'resourceId') =>
  sql`${auditOutbox.entry}->>${sql.raw(`'${key}'`)}`;
const QUEUED_CHANGE = {
  eventId: auditOutbox.eventId,
  before: sql<Record<string, unknown> | null>`${auditOutbox.entry}->'before'`,
  after: sql<Record<string, unknown> | null>`${auditOutbox.entry}->'after'`,
  at: sql`(${auditOutbox.entry}->>'createdAt')::timestamptz`.mapWith(auditLog.createdAt),
};
const CHAINED_CHANGE = {
  eventId: auditLog.eventId,
  before: auditLog.before,
  after: auditLog.after,
  at: auditLog.createdAt,
};

/**
 * Reads `audit_outbox` in the caller's main-database transaction, then `audit_log` in the same
 * transaction or, when the chain has a database of its own, through that. The shipper deletes a
 * row only once it is chained, so the queued rows read first are either still queued or chained
 * by the time the log is read: those found in the log are dropped, and each record counts once.
 */
export class AuditReaderService implements AuditReader {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly auditDrizzle: DrizzleService,
  ) {}

  emailChanges({ playerId, userId }: AuditSubject, tx?: unknown) {
    return this.read(
      tx,
      (db) =>
        db
          .select(QUEUED_CHANGE)
          .from(auditOutbox)
          .where(
            and(
              sql`${queuedField('action')} = ${EMAIL_CHANGED}`,
              or(
                sql`${queuedField('resourceType')} = 'player' AND ${queuedField('resourceId')} = ${playerId}`,
                sql`${queuedField('resourceType')} = 'user' AND ${queuedField('resourceId')} = ${userId}`,
              ),
            ),
          )
          .orderBy(asc(auditOutbox.id)),
      (db) =>
        db
          .select(CHAINED_CHANGE)
          .from(auditLog)
          .where(
            and(
              eq(auditLog.action, EMAIL_CHANGED),
              or(
                and(eq(auditLog.resourceType, 'player'), eq(auditLog.resourceId, playerId)),
                and(eq(auditLog.resourceType, 'user'), eq(auditLog.resourceId, userId)),
              ),
            ),
          )
          .orderBy(asc(auditLog.seq)),
    );
  }

  othersEmailChanges({ email, playerId, userId }: AuditSubject & { email: string }, tx?: unknown) {
    return this.read(
      tx,
      (db) =>
        db
          .select(QUEUED_CHANGE)
          .from(auditOutbox)
          .where(
            and(
              sql`${queuedField('action')} = ${EMAIL_CHANGED}`,
              or(
                sql`lower(${auditOutbox.entry}->'before'->>'email') = lower(${email})`,
                sql`lower(${auditOutbox.entry}->'after'->>'email') = lower(${email})`,
              ),
              sql`(${queuedField('resourceType')} <> 'player' OR ${queuedField('resourceId')} <> ${playerId})`,
              sql`(${queuedField('resourceType')} <> 'user' OR ${queuedField('resourceId')} <> ${userId})`,
            ),
          ),
      (db) =>
        db
          .select(CHAINED_CHANGE)
          .from(auditLog)
          .where(
            and(
              // A literal, not a bound parameter, and the email expressions as the audit migration
              // declares its partial indexes: only then can a generic plan prove it may use them.
              sql`${auditLog.action} = ${sql.raw(`'${EMAIL_CHANGED}'`)}`,
              or(
                sql`lower(${auditLog.before}->>'email') = lower(${email})`,
                sql`lower(${auditLog.after}->>'email') = lower(${email})`,
              ),
              // Both clauses stay, since excluding by subject type alone would drop other accounts.
              or(ne(auditLog.resourceType, 'player'), ne(auditLog.resourceId, playerId)),
              or(ne(auditLog.resourceType, 'user'), ne(auditLog.resourceId, userId)),
            ),
          ),
    );
  }

  private async read(
    tx: unknown,
    queued: (db: DrizzleDb | DrizzleTx) => Promise<Change[]>,
    chained: (db: DrizzleDb | DrizzleTx) => Promise<Change[]>,
  ): Promise<AuditEmailChange[]> {
    const main = (tx as DrizzleTx | undefined) ?? this.drizzle.db;
    const pending = await queued(main);
    const logged = await chained(this.auditDrizzle === this.drizzle ? main : this.auditDrizzle.db);
    const loggedIds = new Set(logged.map(({ eventId }) => eventId));
    return [...logged, ...pending.filter(({ eventId }) => !loggedIds.has(eventId))].map(
      ({ before, after, at }) => ({ before, after, at }),
    );
  }
}
