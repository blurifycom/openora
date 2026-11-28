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

type Change = Omit<AuditEmailChange, 'queued'> & { eventId: string | null };

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
              sql`${auditLog.action} = ${sql.raw(`'${EMAIL_CHANGED}'`)}`,
              or(
                sql`lower(${auditLog.before}->>'email') = lower(${email})`,
                sql`lower(${auditLog.after}->>'email') = lower(${email})`,
              ),
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
    const entry =
      (queued: boolean) =>
      ({ before, after, at }: Change): AuditEmailChange => ({ before, after, at, queued });
    return [
      ...logged.map(entry(false)),
      ...pending.filter(({ eventId }) => !loggedIds.has(eventId)).map(entry(true)),
    ];
  }
}
