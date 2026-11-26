import { randomUUID } from 'node:crypto';
import { os } from '@orpc/server';
import { describe, expect, it } from 'vitest';
import type { AuditWritePort } from '@openora/core/contracts';
import { setErrorReporter } from '../../kernel/error-reporter.js';
import { withRequestContext, type RequestAuditTrail } from '../../kernel/request-context.js';
import { adminMutationAudit } from '../admin-mutation-audit.js';

type Call = Parameters<ReturnType<typeof adminMutationAudit>>[0];
type Entry = Parameters<AuditWritePort['record']>[0];

const COVERED_TOPIC = 'wallet.withdrawal.approved';

function recordingWriter(options: { failing?: boolean } = {}) {
  const entries: Entry[] = [];
  const writer: AuditWritePort = {
    auditedTopics: new Set([COVERED_TOPIC]),
    async record(entry) {
      if (options.failing) {
        throw new Error('audit store unavailable');
      }
      entries.push(entry);
    },
    async recordInTransaction() {},
    async recordManyInTransaction() {},
  };
  return { writer, entries };
}

const approveProcedure = os
  .route({ method: 'POST', path: '/wallet/approve-withdrawal' })
  .handler(() => 'approved');

function adminCall(output: unknown): Call {
  return {
    procedure: approveProcedure,
    path: ['wallet', 'approveWithdrawal'],
    input: { id: randomUUID() },
    next: async () => output,
  };
}

function runAsAdmin(published: string[], fn: () => Promise<unknown>) {
  const trail: RequestAuditTrail = {
    grant: {
      userId: randomUUID(),
      resource: 'wallet',
      action: 'approve',
      ip: '203.0.113.9',
      userAgent: 'e2e',
    },
    writtenFor: new Set(),
    published: new Set(published),
  };
  return withRequestContext({ traceId: randomUUID(), audit: trail }, fn);
}

describe('adminMutationAudit', () => {
  it('does not add a row when it published a topic the audit module covers', async () => {
    const { writer, entries } = recordingWriter();
    const intercept = adminMutationAudit(writer);

    const covered = await runAsAdmin([COVERED_TOPIC], () => intercept(adminCall('covered')));
    const exempt = await runAsAdmin(['wallet.something.exempt'], () =>
      intercept(adminCall('exempt')),
    );

    expect(covered).toBe('covered');
    expect(exempt).toBe('exempt');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'admin.wallet.approve', result: 'success' });
  });

  it('a failing fallback write is logged and does not change the response to the admin', async () => {
    const { writer } = recordingWriter({ failing: true });
    const reported: unknown[] = [];
    setErrorReporter((error) => reported.push(error));
    try {
      const output = { ok: randomUUID() };
      const result = await runAsAdmin([], () => adminMutationAudit(writer)(adminCall(output)));

      expect(result).toBe(output);
      expect(reported).toHaveLength(1);
      expect(reported[0]).toMatchObject({ message: 'audit store unavailable' });
    } finally {
      setErrorReporter(undefined);
    }
  });
});
