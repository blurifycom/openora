import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { eq } from 'drizzle-orm';
import {
  type CacheAdapter,
  type SupportHistoryEmailWindow,
  type SupportHistoryReader,
} from '@openora/core/contracts';
import { createTestDb, seedPlayerWithUser, type TestDb } from '@openora/core/testing';
import { auditLog } from '@openora/core/audit/schema';
import { migrate as migrateAudit } from '@openora/core/audit/migrate';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { user } from '@openora/core/pam/schema/identity';
import { makeCache } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { SupportHistoryService } from '../service/support-history.service.js';

const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('@openora/core/server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createLogger: () => log,
}));

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrateIdentity, migrateProfile, migrateAudit, migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(() => {
  log.warn.mockClear();
});

const HOUR = 3_600_000;

type Subject = 'player' | 'user';
type Row = {
  /** Which resource the row was audited under. Default: the player. */
  subject?: Subject;
  /** An email, `undefined` for no `before` column, or a raw `before` object. */
  before?: string | Record<string, unknown>;
  after?: string | Record<string, unknown>;
  /** Hours after registration. */
  at: number;
  /** Hours after registration the event claims, or a raw value, written into `after.changedAt`. */
  changedAt?: number | string;
  action?: string;
};

/** A player whose current email is `account.email`; `name('a')` is another address of theirs. */
async function scenario(rows: Row[]) {
  const { account, player } = await seedPlayerWithUser(db);
  const [registered] = await db.drizzle.db
    .select({ createdAt: user.createdAt })
    .from(user)
    .where(eq(user.id, account.id));
  const registeredAt = registered?.createdAt as Date;
  const name = (tag: string) => `${tag}-${account.id}@test.dev`;
  const resolve = (value: string) => (value === 'cur' ? account.email : name(value));
  const side = (value: Row['before']) =>
    typeof value === 'string' ? { email: resolve(value) } : value;
  const withChangedAt = (after: ReturnType<typeof side>, changedAt: Row['changedAt']) => {
    if (changedAt === undefined) {
      return after ?? null;
    }
    const value =
      typeof changedAt === 'number'
        ? new Date(registeredAt.getTime() + changedAt * HOUR).toISOString()
        : changedAt;
    return { ...after, changedAt: value };
  };
  for (const row of rows) {
    const subject = row.subject ?? 'player';
    await db.drizzle.db.insert(auditLog).values({
      actorType: 'player',
      actorId: player.id,
      action: row.action ?? 'identity.email.changed',
      resourceType: subject,
      resourceId: subject === 'player' ? player.id : account.id,
      before: side(row.before) ?? null,
      after: withChangedAt(side(row.after), row.changedAt),
      hash: randomUUID(),
      createdAt: new Date(registeredAt.getTime() + row.at * HOUR),
    });
  }
  const at = (hours: number) => new Date(registeredAt.getTime() + hours * HOUR).toISOString();
  const win = (email: string, from: number | 'registered', to: number | null) => ({
    email: resolve(email),
    from: from === 'registered' ? registeredAt.toISOString() : at(from),
    to: to === null ? null : at(to),
  });
  const asked: SupportHistoryEmailWindow[][] = [];
  const reader: SupportHistoryReader = {
    listTickets: async ({ windows }) => {
      asked.push(windows);
      return [];
    },
    listChats: async () => [],
  };
  const service = new SupportHistoryService({ drizzle: db.drizzle, cache: makeCache(), reader });
  const history = await service.getHistory(account.id, false);
  return { history, asked, win, userId: account.id, email: account.email, service };
}

const warnedWithUserOnly = (userId: string) => {
  expect(log.warn.mock.calls.map(([fields]) => fields)).toEqual([{ userId }]);
  expect(inspect(log.warn.mock.calls, { depth: null })).not.toContain('@test.dev');
};

describe('support history email windows from crafted audit rows (real PG)', () => {
  it('builds three windows for two changes and an open one for no change', async () => {
    const two = await scenario([
      { before: 'a', after: 'b', at: 10 },
      { before: 'b', after: 'cur', at: 20 },
    ]);
    expect(two.asked).toEqual([
      [two.win('a', 'registered', 10), two.win('b', 10, 20), two.win('cur', 20, null)],
    ]);
    expect(two.history.tickets.state).toBe('ok');
    expect(log.warn).not.toHaveBeenCalled();

    const none = await scenario([]);
    expect(none.asked).toEqual([[none.win('cur', 'registered', null)]]);
  });

  it('keeps the three most recent of five changes and the current email', async () => {
    const s = await scenario([
      { before: 'e1', after: 'e2', at: 1 },
      { before: 'e2', after: 'e3', at: 2 },
      { before: 'e3', after: 'e4', at: 3 },
      { before: 'e4', after: 'e5', at: 4 },
      { before: 'e5', after: 'cur', at: 5 },
    ]);
    expect(s.asked).toEqual([
      [s.win('e3', 2, 3), s.win('e4', 3, 4), s.win('e5', 4, 5), s.win('cur', 5, null)],
    ]);
  });

  it('cannot notice a lost first change: the next email is kept from registration', async () => {
    // a -> b was never audited; b -> cur was. Nothing records the email registered with.
    const s = await scenario([{ before: 'b', after: 'cur', at: 10 }]);
    expect(s.asked).toEqual([[s.win('b', 'registered', 10), s.win('cur', 10, null)]]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('gives the current email no window starting before it was held when the last change was lost', async () => {
    // a -> b audited, b -> cur lost.
    const s = await scenario([{ before: 'a', after: 'b', at: 10 }]);
    expect(s.asked).toEqual([]);
    expect(s.history.tickets).toEqual({ state: 'unavailable', items: [] });
    warnedWithUserOnly(s.userId);
  });

  it('trusts no window when a lost middle change breaks the trail', async () => {
    // e3 -> e4 lost.
    const s = await scenario([
      { before: 'e1', after: 'e2', at: 1 },
      { before: 'e2', after: 'e3', at: 2 },
      { before: 'e4', after: 'e5', at: 3 },
      { before: 'e5', after: 'cur', at: 4 },
    ]);
    expect(s.asked).toEqual([]);
    expect(s.history.tickets).toEqual({ state: 'unavailable', items: [] });
    warnedWithUserOnly(s.userId);
  });

  it('gives the replaced email no window from registration when the rows were written out of order', async () => {
    const s = await scenario([
      { before: 'b', after: 'cur', at: 20 },
      { before: 'a', after: 'b', at: 10 },
    ]);
    expect(s.asked).toEqual([]);
    expect(s.history.tickets).toEqual({ state: 'unavailable', items: [] });
    warnedWithUserOnly(s.userId);
  });

  it('trusts no window for a duplicated row', async () => {
    const s = await scenario([
      { before: 'a', after: 'cur', at: 10 },
      { before: 'a', after: 'cur', at: 11 },
    ]);
    expect(s.asked).toEqual([]);
    expect(s.history.tickets).toEqual({ state: 'unavailable', items: [] });
    warnedWithUserOnly(s.userId);
  });

  it('keeps contiguous windows for a change to the same email', async () => {
    const s = await scenario([{ before: 'cur', after: 'cur', at: 10 }]);
    expect(s.asked).toEqual([[s.win('cur', 'registered', 10), s.win('cur', 10, null)]]);
  });

  it('trusts no window when the replaced email is missing', async () => {
    const s = await scenario([{ after: 'cur', at: 10 }]);
    expect(s.asked).toEqual([]);
    expect(s.history.tickets).toEqual({ state: 'unavailable', items: [] });
    warnedWithUserOnly(s.userId);
  });

  it('trusts no window when the new email is missing', async () => {
    const s = await scenario([
      { before: 'a', at: 10 },
      { before: 'b', after: 'cur', at: 20 },
    ]);
    expect(s.asked).toEqual([]);
    expect(s.history.tickets).toEqual({ state: 'unavailable', items: [] });
    warnedWithUserOnly(s.userId);
  });

  it('answers tickets unavailable, asking nobody, when every row lacks an email', async () => {
    const s = await scenario([
      { before: {}, after: {}, at: 10 },
      { before: { email: 5 }, after: { email: null }, at: 11 },
      { before: { email: '' }, after: { email: '' }, at: 12 },
    ]);
    expect(s.asked).toEqual([]);
    expect(s.history.tickets).toEqual({ state: 'unavailable', items: [] });
    warnedWithUserOnly(s.userId);
  });

  it('answers no_email, asking nobody and warning nothing, for an account with no email and no change', async () => {
    const { account } = await seedPlayerWithUser(db);
    await db.drizzle.db.update(user).set({ email: '' }).where(eq(user.id, account.id));
    const listTickets = vi.fn(async () => []);
    const service = new SupportHistoryService({
      drizzle: db.drizzle,
      cache: makeCache(),
      reader: { listTickets, listChats: async () => [] },
    });

    const history = await service.getHistory(account.id, false);

    expect(history.tickets).toEqual({ state: 'no_email', items: [] });
    expect(listTickets).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a time that falls back',
      [
        ['a', 'b', 10],
        ['b', 'c', 5],
        ['c', 'cur', 7],
      ],
    ],
    [
      'a time that jumps ahead',
      [
        ['x', 'a', 10],
        ['a', 'b', 30],
        ['b', 'cur', 20],
      ],
    ],
    [
      'two changes at the same time',
      [
        ['a', 'b', 10],
        ['b', 'cur', 10],
      ],
    ],
    ['a change at registration', [['a', 'cur', 0]]],
    ['a change before registration', [['a', 'cur', -5]]],
  ] as const)('trusts no window for %s', async (_fault, trail) => {
    const s = await scenario(trail.map(([before, after, at]) => ({ before, after, at })));
    expect(s.asked).toEqual([]);
    expect(s.history.tickets).toEqual({ state: 'unavailable', items: [] });
    warnedWithUserOnly(s.userId);
  });

  it('trusts no window for a missing new email beside a reordering', async () => {
    const s = await scenario([
      { before: 'b', after: 'cur', at: 20 },
      { before: 'a', at: 21 },
      { before: 'b', after: 'cur', at: 22 },
    ]);
    expect(s.asked).toEqual([]);
    expect(s.history.tickets).toEqual({ state: 'unavailable', items: [] });
    warnedWithUserOnly(s.userId);
  });

  it('times each window by the change time the row carries, however late the row was written', async () => {
    const s = await scenario([
      { before: 'a', after: 'b', at: 10, changedAt: 8 },
      { before: 'b', after: 'cur', at: 20, changedAt: 15 },
    ]);
    expect(s.asked).toEqual([
      [s.win('a', 'registered', 8), s.win('b', 8, 15), s.win('cur', 15, null)],
    ]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('chains a row with a change time and a legacy row without one', async () => {
    const s = await scenario([
      { before: 'a', after: 'b', at: 10, changedAt: 8 },
      { before: 'b', after: 'cur', at: 20 },
    ]);
    expect(s.asked).toEqual([
      [s.win('a', 'registered', 8), s.win('b', 8, 20), s.win('cur', 20, null)],
    ]);
  });

  it.each([
    ['a later change time earlier than the one before', 10, 5],
    ['a later change time equal to the one before', 10, 10],
    ['a later change time before registration', 10, -1],
  ])('trusts no window for %s', async (_fault, first, second) => {
    const s = await scenario([
      { before: 'a', after: 'b', at: 10, changedAt: first },
      { before: 'b', after: 'cur', at: 20, changedAt: second },
    ]);
    expect(s.asked).toEqual([]);
    expect(s.history.tickets).toEqual({ state: 'unavailable', items: [] });
    warnedWithUserOnly(s.userId);
  });

  it('trusts no window when a legacy row written earlier follows a later claimed change time', async () => {
    // First row claims hour 30 but was written at 10; the next, legacy, row falls back to its write time 20.
    const s = await scenario([
      { before: 'a', after: 'b', at: 10, changedAt: 30 },
      { before: 'b', after: 'cur', at: 20 },
    ]);
    expect(s.asked).toEqual([]);
    warnedWithUserOnly(s.userId);
  });

  it.each(['not a time', '2026-03-01 10:00:00', '2026-03-01T10:00:00+02:00', '1767225600'])(
    'falls back to the write time for an unparsable or non-UTC change time (%j)',
    async (changedAt) => {
      const s = await scenario([{ before: 'a', after: 'cur', at: 10, changedAt }]);
      expect(s.asked).toEqual([[s.win('a', 'registered', 10), s.win('cur', 10, null)]]);
    },
  );

  it('chains rows audited under the player and the user in the order written', async () => {
    const s = await scenario([
      { subject: 'user', before: 'a', after: 'b', at: 10 },
      { subject: 'player', before: 'b', after: 'cur', at: 20 },
    ]);
    expect(s.asked).toEqual([
      [s.win('a', 'registered', 10), s.win('b', 10, 20), s.win('cur', 20, null)],
    ]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('gives no window from registration when rows of both subjects are interleaved out of order', async () => {
    const s = await scenario([
      { subject: 'player', before: 'b', after: 'cur', at: 20 },
      { subject: 'user', before: 'a', after: 'b', at: 10 },
    ]);
    expect(s.asked).toEqual([]);
    warnedWithUserOnly(s.userId);
  });

  it('reads no row of another subject, another player or another action', async () => {
    const other = await seedPlayerWithUser(db);
    const strange = { actorType: 'player' as const, hash: randomUUID() };
    const { account, player } = await seedPlayerWithUser(db);
    await db.drizzle.db.insert(auditLog).values([
      // Another player's change, a player id carried by a user subject, a user id carried by a
      // player subject, and a request that never took effect.
      {
        ...strange,
        action: 'identity.email.changed',
        resourceType: 'player',
        resourceId: other.player.id,
        before: { email: 'victim@test.dev' },
        after: { email: 'x@test.dev' },
      },
      {
        ...strange,
        action: 'identity.email.changed',
        resourceType: 'user',
        resourceId: player.id,
        before: { email: 'victim@test.dev' },
        after: { email: account.email },
      },
      {
        ...strange,
        action: 'identity.email.changed',
        resourceType: 'player',
        resourceId: account.id,
        before: { email: 'victim@test.dev' },
        after: { email: account.email },
      },
      {
        ...strange,
        action: 'identity.email.change.requested',
        resourceType: 'player',
        resourceId: player.id,
        before: { email: 'victim@test.dev' },
        after: { email: account.email },
      },
    ]);
    const asked: SupportHistoryEmailWindow[][] = [];
    const service = new SupportHistoryService({
      drizzle: db.drizzle,
      cache: makeCache(),
      reader: {
        listTickets: async ({ windows }) => {
          asked.push(windows);
          return [];
        },
        listChats: async () => [],
      },
    });

    await service.getHistory(account.id, false);

    expect(asked).toHaveLength(1);
    expect(asked[0]?.map((w) => w.email)).toEqual([account.email]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('reads an uppercase user id as the lowercase one, rows and cache entry alike', async () => {
    const s = await scenario([{ subject: 'user', before: 'a', after: 'cur', at: 10 }]);
    expect(s.asked).toHaveLength(1);

    const upper = await s.service.getHistory(s.userId.toUpperCase(), false);

    expect(upper).toEqual(s.history);
    expect(s.asked).toHaveLength(1);
  });
});

describe('support history cache failures (real PG)', () => {
  const countingCache = () => {
    const base = makeCache();
    const calls = { get: 0, set: 0 };
    const cache: CacheAdapter = {
      ...base,
      get: async <T>(key: string) => {
        calls.get++;
        return base.get<T>(key);
      },
      set: async <T>(key: string, value: T, opts: { ttlMs: number }) => {
        calls.set++;
        return base.set(key, value, opts);
      },
    };
    return { cache, calls };
  };
  const reader = (): SupportHistoryReader => ({
    listTickets: vi.fn(async () => []),
    listChats: vi.fn(async () => []),
  });

  it('serves a repeat call from the cache with the first fetchedAt and no second read', async () => {
    const { account } = await seedPlayerWithUser(db);
    const r = reader();
    const service = new SupportHistoryService({
      drizzle: db.drizzle,
      cache: makeCache(),
      reader: r,
    });

    const first = await service.getHistory(account.id, false);
    const second = await service.getHistory(account.id, false);
    await service.getHistory(account.id, true);

    expect(second).toEqual(first);
    expect(r.listTickets).toHaveBeenCalledTimes(2);
  });

  it('does not cache a missing player', async () => {
    const { cache, calls } = countingCache();
    const service = new SupportHistoryService({
      drizzle: db.drizzle,
      cache,
      reader: reader(),
    });
    const unknown = randomUUID();

    await expect(service.getHistory(unknown, false)).rejects.toThrow();
    await expect(service.getHistory(unknown, false)).rejects.toThrow();

    expect(calls.set).toBe(0);
    expect(calls.get).toBe(2);
  });
});
