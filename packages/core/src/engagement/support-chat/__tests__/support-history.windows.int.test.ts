import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { eq, getTableName, sql } from 'drizzle-orm';
import {
  type CacheAdapter,
  type SupportHistoryEmailWindow,
  type SupportHistoryReader,
} from '@openora/core/contracts';
import { createTestDb, seedPlayerWithUser, type TestDb } from '@openora/core/testing';
import { auditLog } from '@openora/core/audit/schema';
import { drainAuditOutbox } from '@openora/core/audit/server';
import { migrate as migrateOutbox } from '@openora/core/server/migrate';
import { migrate as migrateAudit } from '@openora/core/audit/migrate';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { user } from '@openora/core/pam/schema/identity';
import { auditOutbox } from '@openora/core/server';
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
  db = await createTestDb([migrateOutbox, migrateIdentity, migrateProfile, migrateAudit, migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(() => {
  log.warn.mockClear();
});

const HOUR = 3_600_000;

type Subject = 'player' | 'user' | 'other' | 'otherUser';
type Row = {
  /**
   * Which resource the row was audited under, `other` another account's player and `otherUser`
   * another account's user. Default: the player.
   */
  subject?: Subject;
  /** An email, `undefined` for no `before` column, or a raw `before` object. */
  before?: string | Record<string, unknown>;
  after?: string | Record<string, unknown>;
  /** Hours after registration. */
  at: number;
  /** Hours after registration the event claims, or a raw value, written into `after.changedAt`. */
  changedAt?: number | string;
  action?: string;
  /** Still in `audit_outbox`, not yet shipped to `audit_log`. */
  queued?: boolean;
};

/** A player whose current email is `account.email`; `name('a')` is another address of theirs. */
async function scenario(rows: Row[], { registeredEmail }: { registeredEmail?: string } = {}) {
  const { account, player } = await seedPlayerWithUser(db);
  const [registered] = await db.drizzle.db
    .select({ createdAt: user.createdAt })
    .from(user)
    .where(eq(user.id, account.id));
  const registeredAt = registered?.createdAt as Date;
  const name = (tag: string) => `${tag}-${account.id}@test.dev`;
  const resolve = (value: string) =>
    value === 'cur' ? account.email : value === 'CUR' ? account.email.toUpperCase() : name(value);
  if (registeredEmail !== undefined) {
    await db.drizzle.db
      .update(user)
      .set({ registeredEmail: resolve(registeredEmail) })
      .where(eq(user.id, account.id));
  }
  const otherId = randomUUID();
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
    const record = {
      actorType: 'player' as const,
      actorId: player.id,
      action: row.action ?? 'identity.email.changed',
      resourceType: subject === 'user' || subject === 'otherUser' ? 'user' : 'player',
      resourceId: { player: player.id, user: account.id, other: otherId, otherUser: otherId }[
        subject
      ],
      before: side(row.before) ?? null,
      after: withChangedAt(side(row.after), row.changedAt),
    };
    const writtenAt = new Date(registeredAt.getTime() + row.at * HOUR);
    if (row.queued) {
      // Shaped like a real enqueue: an absent side is left out, so the shipper accepts the entry.
      const { before, after, ...rest } = record;
      await db.drizzle.db.insert(auditOutbox).values({
        eventId: randomUUID(),
        entry: {
          ...rest,
          ...(before === null ? {} : { before }),
          ...(after === null ? {} : { after }),
          correlationId: null,
          createdAt: writtenAt.toISOString(),
        },
      });
      continue;
    }
    await db.drizzle.db.insert(auditLog).values({
      ...record,
      // Off-chain rows: a distinct predecessor each, as the unique prev_hash requires.
      prevHash: randomUUID(),
      hash: randomUUID(),
      createdAt: writtenAt,
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
  const readAgain = () =>
    new SupportHistoryService({ drizzle: db.drizzle, cache: makeCache(), reader }).getHistory(
      account.id,
      false,
    );
  return { history, asked, win, userId: account.id, readAgain };
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
    expect(two.history.tickets).toEqual({ state: 'ok', items: [], complete: true });
    expect(log.warn).not.toHaveBeenCalled();

    const none = await scenario([]);
    expect(none.asked).toEqual([[none.win('cur', 'registered', null)]]);
  });

  it('opens the registration window when the oldest email is the one the account registered with', async () => {
    const s = await scenario(
      [
        { before: 'a', after: 'b', at: 10 },
        { before: 'b', after: 'cur', at: 20 },
      ],
      { registeredEmail: 'a' },
    );
    expect(s.asked).toEqual([
      [s.win('a', 'registered', 10), s.win('b', 10, 20), s.win('cur', 20, null)],
    ]);
    expect(s.history.tickets).toEqual({ state: 'ok', items: [], complete: true });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('matches the registered email whatever its case', async () => {
    const s = await scenario([], { registeredEmail: 'CUR' });
    expect(s.asked).toEqual([[s.win('cur', 'registered', null)]]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('notices a lost first change against the registered email and keeps the later windows', async () => {
    const s = await scenario([{ before: 'b', after: 'cur', at: 20 }], { registeredEmail: 'a' });
    expect(s.asked).toEqual([[s.win('cur', 20, null)]]);
    expect(s.history.tickets).toEqual({ state: 'ok', items: [], complete: false });
    warnedWithUserOnly(s.userId);
  });

  it('trusts no window when the account holds another email than it registered with and no row says so', async () => {
    const s = await scenario([], { registeredEmail: 'a' });
    expect(s.asked).toEqual([]);
    expect(s.history.tickets).toEqual({ state: 'email_gap', items: [], complete: false });
    warnedWithUserOnly(s.userId);
  });

  it('trusts no window when the rows were written out of order, read in write order not time order', async () => {
    const s = await scenario([
      { before: 'b', after: 'cur', at: 20 },
      { before: 'a', after: 'b', at: 10 },
    ]);
    expect(s.asked).toEqual([]);
    expect(s.history.tickets).toEqual({ state: 'email_gap', items: [], complete: false });
    warnedWithUserOnly(s.userId);
  });

  it('counts a redelivered row, same emails and same change time, once', async () => {
    const s = await scenario([
      { before: 'a', after: 'cur', at: 10, changedAt: 9 },
      { before: 'a', after: 'cur', at: 11, changedAt: 9 },
    ]);
    expect(s.asked).toEqual([[s.win('a', 'registered', 9), s.win('cur', 9, null)]]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('keeps contiguous windows for a change to the same email', async () => {
    const s = await scenario([{ before: 'cur', after: 'cur', at: 10 }]);
    expect(s.asked).toEqual([[s.win('cur', 'registered', 10), s.win('cur', 10, null)]]);
  });

  it('keeps only the windows after a change whose new email is missing', async () => {
    const s = await scenario([
      { before: 'a', at: 10 },
      { before: 'b', after: 'cur', at: 20 },
    ]);
    expect(s.asked).toEqual([[s.win('cur', 20, null)]]);
    expect(s.history.tickets).toEqual({ state: 'ok', items: [], complete: false });
    warnedWithUserOnly(s.userId);
  });

  it('trusts no window, not even the current one, when no row holds a usable email', async () => {
    const s = await scenario([
      { before: {}, after: {}, at: 10 },
      { before: { email: 5 }, after: { email: null }, at: 11 },
      { before: { email: '' }, after: { email: '' }, at: 12 },
    ]);
    expect(s.asked).toEqual([]);
    expect(s.history.tickets).toEqual({ state: 'email_gap', items: [], complete: false });
    warnedWithUserOnly(s.userId);
  });

  it('warns nothing for an account with no email and no change', async () => {
    const { account } = await seedPlayerWithUser(db);
    await db.drizzle.db.update(user).set({ email: '' }).where(eq(user.id, account.id));
    const service = new SupportHistoryService({
      drizzle: db.drizzle,
      cache: makeCache(),
      reader: { listTickets: async () => [], listChats: async () => [] },
    });

    const history = await service.getHistory(account.id, false);

    expect(history.tickets.state).toBe('no_email');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns nothing when only the cap on previous emails leaves older ones out', async () => {
    const s = await scenario([
      { before: 'a', after: 'b', at: 10 },
      { before: 'b', after: 'c', at: 20 },
      { before: 'c', after: 'd', at: 30 },
      { before: 'd', after: 'cur', at: 40 },
    ]);
    expect(s.history.tickets.complete).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
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

  it('trusts no window when a legacy row written earlier follows a later claimed change time', async () => {
    const s = await scenario([
      { before: 'a', after: 'b', at: 10, changedAt: 30 },
      { before: 'b', after: 'cur', at: 20 },
    ]);
    expect(s.asked).toEqual([]);
    expect(s.history.tickets).toEqual({ state: 'email_gap', items: [], complete: false });
    warnedWithUserOnly(s.userId);
  });

  it('trusts no window when a change time is later than its own audit write', async () => {
    const s = await scenario([{ before: 'a', after: 'cur', at: 10, changedAt: 11 }]);
    expect(s.asked).toEqual([]);
    expect(s.history.tickets).toEqual({ state: 'email_gap', items: [], complete: false });
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

  it('trusts no window when rows of both subjects are interleaved out of order', async () => {
    const s = await scenario([
      { subject: 'player', before: 'b', after: 'cur', at: 20 },
      { subject: 'user', before: 'a', after: 'b', at: 10 },
    ]);
    expect(s.asked).toEqual([]);
    warnedWithUserOnly(s.userId);
  });

  it.each([
    ['player', 'lower', 'other', 'cur'],
    ['user', 'lower', 'otherUser', 'cur'],
    ['player', 'upper', 'other', 'CUR'],
  ] as const)(
    'opens the oldest window when another account (%s subject) left the address in %s case, not at registration',
    async (_kind, _case, subject, before) => {
      const s = await scenario([{ subject, before, after: 'q', at: 5 }]);
      expect(s.asked).toEqual([[s.win('cur', 5, null)]]);
      expect(s.history.tickets).toEqual({ state: 'ok', items: [], complete: false });
      warnedWithUserOnly(s.userId);
    },
  );

  it('trusts no window when another account took the address, whatever its case', async () => {
    const s = await scenario([{ subject: 'other', before: 'q', after: 'CUR', at: 5 }]);
    expect(s.asked).toEqual([]);
    expect(s.history.tickets).toEqual({ state: 'email_gap', items: [], complete: false });
    warnedWithUserOnly(s.userId);
  });

  it('reads a change still queued for the audit chain after the shipped ones', async () => {
    const s = await scenario([
      { before: 'a', after: 'b', at: 10 },
      { before: 'b', after: 'cur', at: 20, queued: true },
    ]);
    expect(s.asked).toEqual([
      [s.win('a', 'registered', 10), s.win('b', 10, 20), s.win('cur', 20, null)],
    ]);
    expect(s.history.tickets).toEqual({ state: 'ok', items: [], complete: true });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('gives the same windows before and after the shipper chains a queued change', async () => {
    const s = await scenario([
      { before: 'a', after: 'b', at: 10 },
      { before: 'b', after: 'cur', at: 20, queued: true },
    ]);
    await drainAuditOutbox(db.drizzle.db);
    const queuedLeft = await db.drizzle.db.select({ id: auditOutbox.id }).from(auditOutbox);
    expect(queuedLeft).toEqual([]);
    const shipped = await s.readAgain();
    expect(s.asked[1]).toEqual(s.asked[0]);
    expect(shipped.tickets).toEqual(s.history.tickets);
  });

  it('trusts no window when another account took the address in a change still queued', async () => {
    const s = await scenario([
      { subject: 'other', before: 'q', after: 'CUR', at: 5, queued: true },
    ]);
    expect(s.asked).toEqual([]);
    expect(s.history.tickets).toEqual({ state: 'email_gap', items: [], complete: false });
    warnedWithUserOnly(s.userId);
  });

  it('reads the account and its email trail from one snapshot when a change commits between the reads', async () => {
    const { account, player } = await seedPlayerWithUser(db);
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

    const { reading } = await db.drizzle.db.transaction(async (change) => {
      await change.execute(sql`LOCK TABLE ${auditLog} IN ACCESS EXCLUSIVE MODE`);
      const reading = service.getHistory(account.id, false);
      await vi.waitFor(
        async () => {
          const { rows } = await change.execute(sql`
            SELECT 1 FROM pg_locks
            WHERE NOT granted
              AND relation = ${getTableName(auditLog)}::regclass
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          `);
          expect(rows).toHaveLength(1);
        },
        { timeout: 10_000, interval: 20 },
      );
      const newEmail = `new-${account.id}@test.dev`;
      await change.update(user).set({ email: newEmail }).where(eq(user.id, account.id));
      await change.insert(auditLog).values({
        actorType: 'player',
        actorId: player.id,
        action: 'identity.email.changed',
        resourceType: 'player',
        resourceId: player.id,
        before: { email: account.email },
        after: { email: newEmail },
        hash: randomUUID(),
      });
      return { reading };
    });
    const history = await reading;

    expect(history.tickets).toEqual({ state: 'ok', items: [], complete: true });
    expect(asked.map((windows) => windows.map((w) => w.email))).toEqual([[account.email]]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('reads no row of another subject, another player or another action', async () => {
    const other = await seedPlayerWithUser(db);
    const { account, player } = await seedPlayerWithUser(db);
    const [registered] = await db.drizzle.db
      .select({ createdAt: user.createdAt })
      .from(user)
      .where(eq(user.id, account.id));
    const registeredAt = registered?.createdAt as Date;
    // Written before registration: another account's change is checked only after it, while one
    // read into this trail would break it.
    const strange = {
      actorType: 'player' as const,
      hash: randomUUID(),
      createdAt: new Date(registeredAt.getTime() - HOUR),
    };
    await db.drizzle.db.insert(auditLog).values(
      [
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
      ].map((row) => ({ ...row, prevHash: randomUUID() })),
    );
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
});

describe('support history cache (real PG)', () => {
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

  it('does not serve an answer cached under the key from before the gap state', async () => {
    const { account } = await seedPlayerWithUser(db);
    const cache = makeCache();
    const oldAnswer = { fetchedAt: 'cached under the old key' };
    await cache.set(`support-chat-history:${account.id}:false`, oldAnswer, { ttlMs: 60_000 });
    const read = reader();
    const service = new SupportHistoryService({ drizzle: db.drizzle, cache, reader: read });

    const history = await service.getHistory(account.id, false);

    expect(history).not.toEqual(oldAnswer);
    expect(read.listTickets).toHaveBeenCalledOnce();
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
