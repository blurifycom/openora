import { describe, it, expect } from 'vitest';
import type { DrizzleService } from '@blurifycom/core/server';
import { mockDb } from '../../testing/mock.js';
import { RgMonitoringService } from '../service/rg-monitoring.service.js';
import { userLimit, rgFlag } from '../schema/index.js';
import { walletTransaction } from '@blurifycom/core/wallet/schema';

type SelectPair = [unknown, unknown];

// Routing Drizzle stub: awaited selects resolve by the table passed to `.from()`;
// inserts/updates are captured for assertions.
function routingDb(cfg: {
  selects: SelectPair[];
  onInsert?: (table: unknown, values: unknown) => void;
  onUpdate?: (table: unknown, set: unknown) => void;
}): DrizzleService {
  const selectMap = new Map(cfg.selects);
  function selectChain() {
    let table: unknown;
    const c: Record<string, unknown> = {
      from: (t: unknown) => {
        table = t;
        return c;
      },
      innerJoin: () => c,
      where: () => c,
      orderBy: () => c,
      limit: () => c,
      offset: () => c,
      then: (resolve: (v: unknown) => unknown) => resolve(selectMap.get(table) ?? []),
    };
    return c;
  }
  const db = {
    select: () => selectChain(),
    insert: (table: unknown) => {
      const c: Record<string, unknown> = {
        values: (v: unknown) => {
          cfg.onInsert?.(table, v);
          return c;
        },
        onConflictDoUpdate: () => c,
        returning: () => Promise.resolve([]),
        then: (resolve: (v: unknown) => unknown) => resolve(undefined),
      };
      return c;
    },
    update: (table: unknown) => {
      const c: Record<string, unknown> = {
        set: (s: unknown) => {
          cfg.onUpdate?.(table, s);
          return c;
        },
        where: () => c,
        returning: () => Promise.resolve([]),
        then: (resolve: (v: unknown) => unknown) => resolve(undefined),
      };
      return c;
    },
  };
  return mockDb(db);
}

const USER = 'user-1';
const depositLimit = { id: 'l1', userId: USER, type: 'deposit', amount: 100, period: 'daily' };

describe('RgMonitoringService.evaluateUser (80% boundary)', () => {
  it('raises a limit_threshold flag at exactly 80% of the limit', async () => {
    const inserts: Array<{ table: unknown; values: unknown }> = [];
    const db = routingDb({
      selects: [
        [userLimit, [depositLimit]],
        [walletTransaction, [{ total: '80' }]],
        [rgFlag, []],
      ],
      onInsert: (table, values) => inserts.push({ table, values }),
    });
    await new RgMonitoringService({ drizzle: db }).evaluateUser(USER, 'wallet.deposit.completed');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.table).toBe(rgFlag);
    expect(inserts[0]!.values).toMatchObject({ flagType: 'limit_threshold', limitType: 'deposit' });
  });

  it('clears the flag when spend drops below 80%', async () => {
    const updates: Array<{ table: unknown; set: unknown }> = [];
    const db = routingDb({
      selects: [
        [userLimit, [depositLimit]],
        [walletTransaction, [{ total: '79' }]],
        [rgFlag, []],
      ],
      onUpdate: (table, set) => updates.push({ table, set }),
    });
    await new RgMonitoringService({ drizzle: db }).evaluateUser(USER, 'wallet.deposit.completed');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.table).toBe(rgFlag);
    expect(updates[0]!.set).toMatchObject({ status: 'cleared' });
  });

  it('raises a self_excluded_login flag on a blocked-login trigger', async () => {
    const inserts: Array<{ table: unknown; values: unknown }> = [];
    const db = routingDb({
      selects: [[rgFlag, []]],
      onInsert: (table, values) => inserts.push({ table, values }),
    });
    await new RgMonitoringService({ drizzle: db }).evaluateUser(USER, 'rg.exclusion.login_blocked');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.values).toMatchObject({ flagType: 'self_excluded_login', limitType: null });
  });
});
