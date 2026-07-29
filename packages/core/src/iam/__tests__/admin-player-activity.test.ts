import { describe, it, expect, vi } from 'vitest';
import type { DrizzleService } from '@openora/core/server';
import { mock } from '../../testing/mock.js';
import { DrizzleAdminPlayerActivity } from '../adapters/admin-player-activity.js';

function makeDrizzle(rows: Record<string, unknown>[]) {
  const execute = vi.fn().mockResolvedValue({ rows });
  return { drizzle: mock<DrizzleService>({ db: { execute } }), execute };
}

describe('DrizzleAdminPlayerActivity.getRegistrationsOverTime', () => {
  it('maps rows to { date, registrations } with a numeric count', async () => {
    const { drizzle } = makeDrizzle([{ date: '2026-01-01', registrations: '3' }]);
    const svc = new DrizzleAdminPlayerActivity(drizzle);

    const rows = await svc.getRegistrationsOverTime({});

    expect(rows).toEqual([{ date: '2026-01-01', registrations: 3 }]);
  });

  it('runs a single query even without an explicit date range (defaults applied)', async () => {
    const { drizzle, execute } = makeDrizzle([]);
    const svc = new DrizzleAdminPlayerActivity(drizzle);

    await svc.getRegistrationsOverTime({});

    expect(execute).toHaveBeenCalledOnce();
  });
});

describe('DrizzleAdminPlayerActivity.getActiveUsersTrend', () => {
  it('maps rows to { date, dau, wau, mau } as numbers', async () => {
    const { drizzle } = makeDrizzle([{ date: '2026-01-01', dau: '1', wau: '4', mau: '10' }]);
    const svc = new DrizzleAdminPlayerActivity(drizzle);

    const rows = await svc.getActiveUsersTrend({});

    expect(rows).toEqual([{ date: '2026-01-01', dau: 1, wau: 4, mau: 10 }]);
  });
});

describe('DrizzleAdminPlayerActivity.getRetentionCohorts', () => {
  it('computes returnRate from cohortSize/returned and passes through isComplete', async () => {
    const { drizzle } = makeDrizzle([
      { cohort_date: '2026-01-01', cohort_size: '10', returned: '4', is_complete: true },
    ]);
    const svc = new DrizzleAdminPlayerActivity(drizzle);

    const rows = await svc.getRetentionCohorts({}, 7);

    expect(rows).toEqual([
      { cohortDate: '2026-01-01', cohortSize: 10, returned: 4, returnRate: 0.4, isComplete: true },
    ]);
  });

  it('flags an incomplete cohort whose window has not elapsed yet', async () => {
    const { drizzle } = makeDrizzle([
      { cohort_date: '2026-07-20', cohort_size: '5', returned: '1', is_complete: false },
    ]);
    const svc = new DrizzleAdminPlayerActivity(drizzle);

    const rows = await svc.getRetentionCohorts({}, 30);

    expect(rows[0]?.isComplete).toBe(false);
  });

  it('returns a 0 rate for an empty cohort instead of dividing by zero', async () => {
    const { drizzle } = makeDrizzle([
      { cohort_date: '2026-01-01', cohort_size: '0', returned: '0', is_complete: false },
    ]);
    const svc = new DrizzleAdminPlayerActivity(drizzle);

    const rows = await svc.getRetentionCohorts({}, 30);

    expect(rows[0]?.returnRate).toBe(0);
  });
});
