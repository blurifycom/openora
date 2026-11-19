import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  AUDIT_WRITER,
  MAIL_DISPATCH,
  type AuditWritePort,
  type MailDispatchPort,
} from '@openora/core/contracts';
import { setErrorReporter } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { migrate as migrateAudit } from '@openora/core/audit/migrate';
import { migrate as migrateOutbox } from '@openora/core/server/migrate';
import { AuditService, drainAuditOutbox } from '@openora/core/audit/server';
import { makeAuditWriter, makeEventBus, makeIdentityReader, mock } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { notification } from '../schema/index.js';
import { bootPluginHarness } from '../../../testing/plugin-harness.js';
import notificationsPlugin from '../plugin.js';

const QUEUE = 'kyc-resubmission-notify';

let db: TestDb;

const advancedRequest = (userId: string, reason: string) => ({
  userId,
  playerId: null,
  actorId: randomUUID(),
  status: 'resubmission_requested',
  previousStatus: 'approved',
  reason,
  source: 'manual',
  tier: 'advanced',
});

beforeAll(async () => {
  db = await createTestDb([migrateOutbox, migrate, migrateAudit]);
});

afterAll(async () => {
  await db.drop();
});

describe('KYC resubmission notify job - mail enqueue failure (real PG)', () => {
  it('fails the job when the mail enqueue rejects, and its retry sends the notice once', async () => {
    const toUser = vi
      .fn<MailDispatchPort['toUser']>()
      .mockRejectedValueOnce(new Error('mail queue unavailable'))
      .mockResolvedValueOnce(undefined);
    const { fire, runJob, enqueued } = bootPluginHarness(notificationsPlugin, db, {
      ports: [[MAIL_DISPATCH, mock<MailDispatchPort>({ toUser, toAddress: vi.fn() })]],
    });
    const userId = randomUUID();
    const eventId = randomUUID();
    const reason = 'source of funds unclear';

    await fire('compliance.kyc.updated', advancedRequest(userId, reason), eventId);

    expect(enqueued).toHaveLength(1);
    const [job] = enqueued;
    expect(job?.queue).toBe(QUEUE);
    expect(job?.payload).toEqual({ userId, reason: null, tier: 'advanced', eventId });
    expect(job?.opts).toMatchObject({
      idempotencyKey: `kyc-resubmission-notify:${eventId}`,
      attempts: 5,
      backoff: { type: 'exponential', delayMs: 1000 },
    });

    await expect(runJob(QUEUE, job?.payload, 1)).rejects.toThrow('mail queue unavailable');
    await expect(runJob(QUEUE, job?.payload, 2)).resolves.toBeUndefined();

    const expectedMail = {
      userId,
      template: { key: 'kycResubmissionRequested', data: { reason: null, tier: 'advanced' } },
      idempotencyKey: `notifications-mail:${eventId}`,
    };
    expect(toUser).toHaveBeenCalledTimes(2);
    expect(toUser).toHaveBeenNthCalledWith(1, expectedMail);
    expect(toUser).toHaveBeenNthCalledWith(2, expectedMail);

    const rows = await db.drizzle.db
      .select()
      .from(notification)
      .where(eq(notification.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'kyc.resubmission_requested',
      eventId,
      params: { tier: 'advanced' },
    });
  });

  it('records a failed regulatory delivery when the notice never reaches the mail queue', async () => {
    const audit = makeAuditWriter();
    const enqueueFailure = new Error('mail queue unavailable');
    const toUser = vi.fn<MailDispatchPort['toUser']>().mockRejectedValue(enqueueFailure);
    const { fire, runJob, deadLetter, enqueued } = bootPluginHarness(notificationsPlugin, db, {
      ports: [
        [MAIL_DISPATCH, mock<MailDispatchPort>({ toUser, toAddress: vi.fn() })],
        [AUDIT_WRITER, audit],
      ],
    });
    const userId = randomUUID();

    await fire('compliance.kyc.updated', advancedRequest(userId, 'address proof expired'));
    const payload = enqueued[0]?.payload;
    await expect(runJob(QUEUE, payload, 5)).rejects.toBe(enqueueFailure);
    await deadLetter(QUEUE, payload, 5, enqueueFailure);

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith({
      actorType: 'system',
      action: 'mail.regulatory_delivery.failed',
      resourceType: 'email',
      resourceId: userId,
      after: { templateKey: 'kycResubmissionRequested', reason: 'enqueue_exhausted', attempt: 5 },
    });
  });
});

describe('KYC resubmission notify job - dead-letter audit on the real audit writer (real PG)', () => {
  // The audit plugin's own AUDIT_WRITER shape over the real AuditService, so "exactly one
  // audit entry" is a row count in audit_log rather than a call count on a spy.
  const realAuditWriter = (): AuditWritePort => {
    const svc = new AuditService(db.drizzle, makeEventBus(), makeIdentityReader());
    return {
      auditedTopics: new Set(),
      record: (entry) => svc.record(entry).then(() => undefined),
      recordInTransaction: (tx, entry) => svc.recordInTransaction(tx, entry).then(() => undefined),
      recordManyInTransaction: (tx, entries) =>
        svc.recordManyInTransaction(tx, entries).then(() => undefined),
    };
  };
  const auditRowsFor = async (resourceId: string) => {
    await drainAuditOutbox(db.drizzle.db);
    return db.drizzle.db.select().from(auditLog).where(eq(auditLog.resourceId, resourceId));
  };

  it('writes exactly one mail.regulatory_delivery.failed row once retries are exhausted', async () => {
    const enqueueFailure = new Error('mail queue unavailable');
    const toUser = vi.fn<MailDispatchPort['toUser']>().mockRejectedValue(enqueueFailure);
    const { fire, runJob, deadLetter, enqueued } = bootPluginHarness(notificationsPlugin, db, {
      ports: [
        [MAIL_DISPATCH, mock<MailDispatchPort>({ toUser, toAddress: vi.fn() })],
        [AUDIT_WRITER, realAuditWriter()],
      ],
    });
    const userId = randomUUID();

    await fire('compliance.kyc.updated', advancedRequest(userId, 'address proof expired'));
    const payload = enqueued[0]?.payload;
    for (let attempt = 1; attempt <= 4; attempt++) {
      await expect(runJob(QUEUE, payload, attempt)).rejects.toBe(enqueueFailure);
    }
    expect(await auditRowsFor(userId)).toHaveLength(0);

    await expect(runJob(QUEUE, payload, 5)).rejects.toBe(enqueueFailure);
    await deadLetter(QUEUE, payload, 5, enqueueFailure);

    const rows = await auditRowsFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: 'system',
      action: 'mail.regulatory_delivery.failed',
      resourceType: 'email',
      resourceId: userId,
      after: { templateKey: 'kycResubmissionRequested', reason: 'enqueue_exhausted', attempt: 5 },
    });
  });

  it('logs a failing audit write instead of throwing it out of the dead-letter hook', async () => {
    const reported: unknown[] = [];
    setErrorReporter((error) => reported.push(error));
    try {
      const enqueueFailure = new Error('mail queue unavailable');
      const auditFailure = new Error('audit store unavailable');
      const audit = makeAuditWriter();
      audit.record.mockRejectedValue(auditFailure);
      const toUser = vi.fn<MailDispatchPort['toUser']>().mockRejectedValue(enqueueFailure);
      const { fire, deadLetter, enqueued } = bootPluginHarness(notificationsPlugin, db, {
        ports: [
          [MAIL_DISPATCH, mock<MailDispatchPort>({ toUser, toAddress: vi.fn() })],
          [AUDIT_WRITER, audit],
        ],
      });

      await fire('compliance.kyc.updated', advancedRequest(randomUUID(), 'address proof expired'));
      await expect(
        deadLetter(QUEUE, enqueued[0]?.payload, 5, enqueueFailure),
      ).resolves.toBeUndefined();

      expect(audit.record).toHaveBeenCalledTimes(1);
      // An error-level log carrying `err` reaches the error reporter: the audit failure was logged.
      expect(reported).toContain(auditFailure);
    } finally {
      setErrorReporter(undefined);
    }
  });
});
