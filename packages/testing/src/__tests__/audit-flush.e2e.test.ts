import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE, auditOutbox } from '@openora/core/server';
import { AUDIT_WRITER } from '@openora/core/contracts';
import { auditLog } from '@openora/core/audit/schema';
import { bootE2e, closeE2e, flushAudit, type TestApp, type TestDb } from '../index.js';

let db: TestDb;
let testApp: TestApp;

beforeAll(async () => {
  ({ db, app: testApp } = await bootE2e({ seed: false }));
}, 60_000);

afterAll(async () => {
  await closeE2e({ app: testApp, db });
});

describe('audit records written outside a request', () => {
  it('stay queued in the outbox until flushAudit ships them', async () => {
    const drizzle = testApp.container.get(DRIZZLE).db;
    const resourceId = randomUUID();
    // Holding the shipper's lock keeps the background shipper from shipping under the test.
    const holder = new pg.Client({ connectionString: db.url });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtext('audit_shipper'))`);

      await testApp.container.get(AUDIT_WRITER).record({
        actorType: 'system',
        action: 'test.audit.flushed',
        resourceType: 'test',
        resourceId,
      });

      const pending = await drizzle
        .select({ id: auditOutbox.id })
        .from(auditOutbox)
        .where(sql`${auditOutbox.entry}->>'resourceId' = ${resourceId}`);
      expect(pending).toHaveLength(1);
      expect(
        await drizzle.select().from(auditLog).where(eq(auditLog.resourceId, resourceId)),
      ).toHaveLength(0);
    } finally {
      await holder.query('COMMIT');
      await holder.end();
    }

    await flushAudit(testApp);

    const shipped = await drizzle
      .select()
      .from(auditLog)
      .where(eq(auditLog.resourceId, resourceId));
    expect(shipped).toEqual([expect.objectContaining({ action: 'test.audit.flushed' })]);
  });
});
