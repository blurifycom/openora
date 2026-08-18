import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { mock } from '../../testing/mock.js';
import type {
  AdminGameReporting,
  AdminPlayerActivity,
  AdminTxDetail,
  AdminTxRow,
  AdminUserDirectory,
  AdminWalletReporting,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateGaming } from '@openora/core/casino/migrate/gaming';
import { game, gameRound } from '@openora/core/casino/schema/gaming';
import { DrizzleAdminGameReporting } from '@openora/core/casino/server';
import { BackofficeService, TransactionNotFoundError } from '../service/backoffice.service.js';
import { AdminTransactionSchema } from '../contract/index.js';

function makeUsers(over: Partial<AdminUserDirectory> = {}): AdminUserDirectory {
  return mock<AdminUserDirectory>({
    count: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    lookupPlayers: vi.fn().mockResolvedValue([]),
    findPlayerIds: vi.fn().mockResolvedValue([]),
    ...over,
  });
}

function makeReporting(over: Partial<AdminWalletReporting> = {}): AdminWalletReporting {
  return mock<AdminWalletReporting>({
    totals: vi.fn(),
    listTransactions: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    getTransaction: vi.fn().mockResolvedValue(null),
    ...over,
  });
}

function makeGameReporting(over: Partial<AdminGameReporting> = {}): AdminGameReporting {
  return mock<AdminGameReporting>({
    listGamePerformance: vi.fn().mockResolvedValue([]),
    ...over,
  });
}

function makePlayerActivity(over: Partial<AdminPlayerActivity> = {}): AdminPlayerActivity {
  return mock<AdminPlayerActivity>({
    getRegistrationsOverTime: vi.fn().mockResolvedValue([]),
    getActiveUsersTrend: vi.fn().mockResolvedValue([]),
    getRetentionCohorts: vi.fn().mockResolvedValue([]),
    ...over,
  });
}

function txRow(over: Partial<AdminTxRow> = {}): AdminTxRow {
  return {
    id: 'tx-1',
    userId: 'u-1',
    type: 'deposit',
    amount: '100',
    currency: 'USD',
    status: 'completed',
    rail: 'fiat',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  };
}

describe('BackofficeService.listTransactions', () => {
  it('resolves a player query to userIds and enriches rows with email and playerId', async () => {
    const txId = randomUUID();
    const userId = randomUUID();
    const playerId = randomUUID();
    const findPlayerIds = vi.fn().mockResolvedValue([userId]);
    const listTransactions = vi
      .fn()
      .mockResolvedValue({ rows: [txRow({ id: txId, userId })], total: 1 });
    const lookupPlayers = vi.fn().mockResolvedValue([
      {
        playerId,
        userId,
        username: 'alice',
        email: 'alice@example.com',
        kycStatus: 'verified',
      },
    ]);
    const svc = new BackofficeService(
      makeUsers({ findPlayerIds, lookupPlayers }),
      makeReporting({ listTransactions }),
      makeGameReporting(),
      makePlayerActivity(),
    );
    const res = await svc.listTransactions({ page: 1, limit: 20, player: 'alice' });
    expect(findPlayerIds).toHaveBeenCalledWith('alice');
    expect(listTransactions).toHaveBeenCalledWith(expect.objectContaining({ userIds: [userId] }));
    expect(res.items[0]).toMatchObject({
      rail: 'fiat',
      playerId,
      playerEmail: 'alice@example.com',
    });
    expect(() => AdminTransactionSchema.parse(res.items[0])).not.toThrow();
  });

  it('uses an explicit userId directly when no player query is given', async () => {
    const findPlayerIds = vi.fn();
    const listTransactions = vi.fn().mockResolvedValue({ rows: [], total: 0 });
    const svc = new BackofficeService(
      makeUsers({ findPlayerIds }),
      makeReporting({ listTransactions }),
      makeGameReporting(),
      makePlayerActivity(),
    );
    await svc.listTransactions({ page: 1, limit: 20, userId: 'u-1' });
    expect(findPlayerIds).not.toHaveBeenCalled();
    expect(listTransactions).toHaveBeenCalledWith(expect.objectContaining({ userIds: ['u-1'] }));
  });

  it('intersects an explicit userId with the resolved player ids', async () => {
    const findPlayerIds = vi.fn().mockResolvedValue(['u-1', 'u-2']);
    const listTransactions = vi.fn().mockResolvedValue({ rows: [], total: 0 });
    const svc = new BackofficeService(
      makeUsers({ findPlayerIds }),
      makeReporting({ listTransactions }),
      makeGameReporting(),
      makePlayerActivity(),
    );
    await svc.listTransactions({ page: 1, limit: 20, userId: 'u-2', player: 'al' });
    expect(listTransactions).toHaveBeenCalledWith(expect.objectContaining({ userIds: ['u-2'] }));
  });

  it('short-circuits when userId is not in the resolved player set', async () => {
    const findPlayerIds = vi.fn().mockResolvedValue(['u-1', 'u-2']);
    const listTransactions = vi.fn();
    const svc = new BackofficeService(
      makeUsers({ findPlayerIds }),
      makeReporting({ listTransactions }),
      makeGameReporting(),
      makePlayerActivity(),
    );
    const res = await svc.listTransactions({ page: 1, limit: 20, userId: 'u-9', player: 'al' });
    expect(res).toEqual({ items: [], total: 0, page: 1, limit: 20 });
    expect(listTransactions).not.toHaveBeenCalled();
  });

  it('short-circuits when the player query resolves to no ids', async () => {
    const findPlayerIds = vi.fn().mockResolvedValue([]);
    const listTransactions = vi.fn();
    const svc = new BackofficeService(
      makeUsers({ findPlayerIds }),
      makeReporting({ listTransactions }),
      makeGameReporting(),
      makePlayerActivity(),
    );
    const res = await svc.listTransactions({ page: 1, limit: 20, player: 'ghost' });
    expect(res).toEqual({ items: [], total: 0, page: 1, limit: 20 });
    expect(listTransactions).not.toHaveBeenCalled();
  });

  it('leaves player fields null when enrichment does not resolve a row', async () => {
    const listTransactions = vi.fn().mockResolvedValue({ rows: [txRow()], total: 1 });
    const svc = new BackofficeService(
      makeUsers(),
      makeReporting({ listTransactions }),
      makeGameReporting(),
      makePlayerActivity(),
    );
    const res = await svc.listTransactions({ page: 1, limit: 20 });
    expect(res.items[0]).toMatchObject({ playerId: null, playerEmail: null });
  });

  it('converts ISO date filters to Date for the port', async () => {
    const listTransactions = vi.fn().mockResolvedValue({ rows: [], total: 0 });
    const svc = new BackofficeService(
      makeUsers(),
      makeReporting({ listTransactions }),
      makeGameReporting(),
      makePlayerActivity(),
    );
    await svc.listTransactions({
      page: 1,
      limit: 20,
      dateFrom: '2026-01-01T00:00:00.000Z',
      dateTo: '2026-02-01T00:00:00.000Z',
    });
    const arg = listTransactions.mock.calls[0]?.[0];
    expect(arg.dateFrom).toBeInstanceOf(Date);
    expect(arg.dateTo).toBeInstanceOf(Date);
  });
});

describe('BackofficeService.getTransaction', () => {
  function detail(over: Partial<AdminTxDetail> = {}): AdminTxDetail {
    return {
      ...txRow(),
      providerRefId: 'pi_1',
      providerName: 'stripe',
      reviewedBy: 'admin-1',
      reviewedAt: new Date('2026-01-02T00:00:00.000Z'),
      reviewReason: 'manual',
      ...over,
    };
  }

  it('throws TransactionNotFoundError when the port returns null', async () => {
    const svc = new BackofficeService(
      makeUsers(),
      makeReporting(),
      makeGameReporting(),
      makePlayerActivity(),
    );
    await expect(svc.getTransaction('missing')).rejects.toBeInstanceOf(TransactionNotFoundError);
  });

  it('maps the detail incl. ISO reviewedAt and enriched player', async () => {
    const playerId = randomUUID();
    const lookupPlayers = vi.fn().mockResolvedValue([
      {
        playerId,
        userId: 'u-1',
        username: 'alice',
        email: 'alice@example.com',
        kycStatus: 'verified',
      },
    ]);
    const svc = new BackofficeService(
      makeUsers({ lookupPlayers }),
      makeReporting({ getTransaction: vi.fn().mockResolvedValue(detail()) }),
      makeGameReporting(),
      makePlayerActivity(),
    );
    const res = await svc.getTransaction('tx-1');
    expect(res).toMatchObject({
      providerName: 'stripe',
      providerRefId: 'pi_1',
      reviewedAt: '2026-01-02T00:00:00.000Z',
      playerId,
      playerEmail: 'alice@example.com',
      playerUsername: 'alice',
      playerKycStatus: 'verified',
    });
  });

  it('maps a null reviewedAt to null', async () => {
    const svc = new BackofficeService(
      makeUsers(),
      makeReporting({ getTransaction: vi.fn().mockResolvedValue(detail({ reviewedAt: null })) }),
      makeGameReporting(),
      makePlayerActivity(),
    );
    const res = await svc.getTransaction('tx-1');
    expect(res.reviewedAt).toBeNull();
  });
});

describe('BackofficeService.getGamePerformance (real PG)', () => {
  let db: TestDb;
  let gameReporting: DrizzleAdminGameReporting;

  beforeAll(async () => {
    db = await createTestDb([migrateGaming]);
    gameReporting = new DrizzleAdminGameReporting(db.drizzle);
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.drizzle.db.execute(sql`TRUNCATE ${gameRound}, ${game} RESTART IDENTITY CASCADE`);
  });

  function makeService() {
    return new BackofficeService(makeUsers(), makeReporting(), gameReporting, makePlayerActivity());
  }

  async function seedGame(overrides: Partial<typeof game.$inferInsert> = {}) {
    const [row] = await db.drizzle.db
      .insert(game)
      .values({ name: 'Aces', provider: 'p', category: 'slots', ...overrides })
      .returning();
    return row!;
  }

  async function seedRound(gameId: string, overrides: Partial<typeof gameRound.$inferInsert> = {}) {
    await db.drizzle.db.insert(gameRound).values({
      gameId,
      userId: randomUUID(),
      status: 'completed',
      betAmount: '100',
      winAmount: '0',
      currency: 'USD',
      startedAt: new Date('2026-01-15T00:00:00.000Z'),
      ...overrides,
    });
  }

  it('converts ISO date filters to Date and passes gameType/currency/sort through to the port', async () => {
    const g = await seedGame({ gameType: 'casino' });
    await seedGame({ gameType: 'sportsbook' });
    await seedRound(g.id, { betAmount: '100', winAmount: '20', currency: 'EUR' });
    await seedRound(g.id, { betAmount: '50', currency: 'USD' });

    const rows = await makeService().getGamePerformance({
      dateFrom: '2026-01-01T00:00:00.000Z',
      dateTo: '2026-02-01T00:00:00.000Z',
      gameType: 'casino',
      currency: 'EUR',
      sortBy: 'revenue',
      sortDir: 'asc',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ gameId: g.id, roundsPlayed: 1 });
    expect(Number(rows[0]?.volume)).toBe(100);
  });

  it('returns an empty array when there are no games at all', async () => {
    const rows = await makeService().getGamePerformance({});

    expect(rows).toEqual([]);
  });

  it('leaves dateFrom/dateTo unbounded for the port when the filter omits them', async () => {
    const g = await seedGame();
    await seedRound(g.id, { startedAt: new Date('2020-01-01T00:00:00.000Z') });

    const rows = await makeService().getGamePerformance({});

    expect(rows[0]).toMatchObject({ gameId: g.id, roundsPlayed: 1 });
  });
});

describe('BackofficeService.getPlayerActivity', () => {
  it('calls all three port methods, incl. both retention windows, and assembles the DTO', async () => {
    const getRegistrationsOverTime = vi
      .fn()
      .mockResolvedValue([{ date: '2026-01-01', registrations: 3 }]);
    const getActiveUsersTrend = vi
      .fn()
      .mockResolvedValue([{ date: '2026-01-01', dau: 1, wau: 2, mau: 3 }]);
    const sevenDay = [
      { cohortDate: '2026-01-01', cohortSize: 10, returned: 4, returnRate: 0.4, isComplete: true },
    ];
    const thirtyDay = [
      { cohortDate: '2026-01-01', cohortSize: 10, returned: 2, returnRate: 0.2, isComplete: false },
    ];
    const getRetentionCohorts = vi
      .fn()
      .mockResolvedValueOnce(sevenDay)
      .mockResolvedValueOnce(thirtyDay);
    const svc = new BackofficeService(
      makeUsers(),
      makeReporting(),
      makeGameReporting(),
      makePlayerActivity({ getRegistrationsOverTime, getActiveUsersTrend, getRetentionCohorts }),
    );

    const res = await svc.getPlayerActivity({
      dateFrom: '2026-01-01T00:00:00.000Z',
      dateTo: '2026-02-01T00:00:00.000Z',
    });

    const expectedFilter = {
      dateFrom: new Date('2026-01-01T00:00:00.000Z'),
      dateTo: new Date('2026-02-01T00:00:00.000Z'),
    };
    expect(getRegistrationsOverTime).toHaveBeenCalledWith(expectedFilter);
    expect(getActiveUsersTrend).toHaveBeenCalledWith(expectedFilter);
    expect(getRetentionCohorts).toHaveBeenNthCalledWith(1, expectedFilter, 7);
    expect(getRetentionCohorts).toHaveBeenNthCalledWith(2, expectedFilter, 30);
    expect(res).toEqual({
      registrationsOverTime: [{ date: '2026-01-01', registrations: 3 }],
      activeUsersTrend: [{ date: '2026-01-01', dau: 1, wau: 2, mau: 3 }],
      retention: { sevenDay, thirtyDay },
    });
  });
});
