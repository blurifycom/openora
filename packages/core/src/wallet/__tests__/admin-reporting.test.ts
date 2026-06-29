import { describe, it, expect, vi } from 'vitest';
import type { DrizzleService } from '@blurifycom/core/server';
import { DrizzleAdminWalletReporting } from '../admin-reporting.js';

type Row = Record<string, unknown>;

function makeDrizzle(selectQueues: Row[][]) {
  const whereArgs: unknown[] = [];
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder['select'] = vi.fn(chain);
  builder['from'] = vi.fn(chain);
  builder['innerJoin'] = vi.fn(chain);
  builder['orderBy'] = vi.fn(chain);
  builder['limit'] = vi.fn(chain);
  builder['offset'] = vi.fn(chain);
  builder['where'] = vi.fn((arg: unknown) => {
    whereArgs.push(arg);
    return builder;
  });
  // oxlint-disable-next-line unicorn/no-thenable -- builder must be awaitable to mimic Drizzle.
  builder['then'] = (resolve: (v: Row[]) => unknown) => resolve(selectQueues.shift() ?? []);
  const db = { ...builder } as unknown;
  return { drizzle: { db } as unknown as DrizzleService, whereArgs };
}

function txRow(overrides: Row = {}): Row {
  return {
    id: 'tx-1',
    walletId: 'w-1',
    type: 'deposit',
    amount: '100',
    currency: 'USD',
    status: 'completed',
    rail: 'fiat',
    reviewedBy: null,
    reviewedAt: null,
    reviewReason: null,
    providerName: null,
    providerRefId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('DrizzleAdminWalletReporting.listTransactions', () => {
  it('returns mapped rows incl. rail and a numeric amount', async () => {
    const { drizzle } = makeDrizzle([[{ tx: txRow(), walletUserId: 'u-1' }], [{ n: 1 }]]);
    const reporting = new DrizzleAdminWalletReporting(drizzle);
    const { rows, total } = await reporting.listTransactions({ page: 1, limit: 20 });
    expect(total).toBe(1);
    expect(rows[0]).toMatchObject({ id: 'tx-1', userId: 'u-1', amount: 100, rail: 'fiat' });
  });

  it('maps a null rail to null', async () => {
    const { drizzle } = makeDrizzle([
      [{ tx: txRow({ rail: null }), walletUserId: 'u-1' }],
      [{ n: 1 }],
    ]);
    const reporting = new DrizzleAdminWalletReporting(drizzle);
    const { rows } = await reporting.listTransactions({ page: 1, limit: 20 });
    expect(rows[0]?.rail).toBeNull();
  });

  it('builds a where clause when filters are present', async () => {
    const { drizzle, whereArgs } = makeDrizzle([[], [{ n: 0 }]]);
    const reporting = new DrizzleAdminWalletReporting(drizzle);
    await reporting.listTransactions({
      page: 1,
      limit: 20,
      userIds: ['u-1'],
      type: 'bet',
      currency: 'USD',
      rail: 'fiat',
      status: 'completed',
      dateFrom: new Date('2026-01-01'),
      dateTo: new Date('2026-02-01'),
    });
    expect(whereArgs.every((a) => a !== undefined)).toBe(true);
  });

  it('passes an undefined where when no filters are present', async () => {
    const { drizzle, whereArgs } = makeDrizzle([[], [{ n: 0 }]]);
    const reporting = new DrizzleAdminWalletReporting(drizzle);
    await reporting.listTransactions({ page: 1, limit: 20 });
    expect(whereArgs).toEqual([undefined, undefined]);
  });

  it('ignores an empty userIds array (no inArray condition)', async () => {
    const { drizzle, whereArgs } = makeDrizzle([[], [{ n: 0 }]]);
    const reporting = new DrizzleAdminWalletReporting(drizzle);
    await reporting.listTransactions({ page: 1, limit: 20, userIds: [] });
    expect(whereArgs).toEqual([undefined, undefined]);
  });
});

describe('DrizzleAdminWalletReporting.getTransaction', () => {
  it('returns null when no row matches', async () => {
    const { drizzle } = makeDrizzle([[]]);
    const reporting = new DrizzleAdminWalletReporting(drizzle);
    expect(await reporting.getTransaction('missing')).toBeNull();
  });

  it('surfaces the providerName + providerRefId columns', async () => {
    const { drizzle } = makeDrizzle([
      [{ tx: txRow({ providerName: 'stripe', providerRefId: 'pi_123' }), walletUserId: 'u-1' }],
    ]);
    const reporting = new DrizzleAdminWalletReporting(drizzle);
    const detail = await reporting.getTransaction('tx-1');
    expect(detail).toMatchObject({ providerName: 'stripe', providerRefId: 'pi_123' });
  });

  it('maps null provider columns to null and surfaces review columns', async () => {
    const { drizzle } = makeDrizzle([
      [
        {
          tx: txRow({
            reviewedBy: 'admin-1',
            reviewedAt: new Date('2026-01-02T00:00:00.000Z'),
            reviewReason: 'manual',
          }),
          walletUserId: 'u-1',
        },
      ],
    ]);
    const reporting = new DrizzleAdminWalletReporting(drizzle);
    const detail = await reporting.getTransaction('tx-1');
    expect(detail).toMatchObject({
      providerName: null,
      providerRefId: null,
      reviewedBy: 'admin-1',
      reviewReason: 'manual',
    });
  });
});
