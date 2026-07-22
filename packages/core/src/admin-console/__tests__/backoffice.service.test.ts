import { describe, it, expect, vi } from 'vitest';
import { mock } from '../../testing/mock.js';
import type {
  AdminGameReporting,
  AdminPlayerActivity,
  AdminTxDetail,
  AdminTxRow,
  AdminUserDirectory,
  AdminWalletReporting,
} from '@openora/core/contracts';
import {
  BackofficeService,
  TransactionNotFoundError,
  UserNotFoundError,
} from '../service/backoffice.service.js';

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

describe('BackofficeService domain errors', () => {
  it('UserNotFoundError carries the userId', () => {
    const err = new UserNotFoundError('user-123');
    expect(err.name).toBe('UserNotFoundError');
    expect(err.message).toContain('user-123');
  });

  it('TransactionNotFoundError carries the id', () => {
    const err = new TransactionNotFoundError('tx-123');
    expect(err.name).toBe('TransactionNotFoundError');
    expect(err.message).toContain('tx-123');
  });
});

describe('BackofficeService.listTransactions', () => {
  it('resolves a player query to userIds and enriches rows with email', async () => {
    const findPlayerIds = vi.fn().mockResolvedValue(['u-1']);
    const listTransactions = vi.fn().mockResolvedValue({ rows: [txRow()], total: 1 });
    const lookupPlayers = vi
      .fn()
      .mockResolvedValue([
        { userId: 'u-1', username: 'alice', email: 'alice@example.com', kycStatus: 'verified' },
      ]);
    const svc = new BackofficeService(
      makeUsers({ findPlayerIds, lookupPlayers }),
      makeReporting({ listTransactions }),
      makeGameReporting(),
      makePlayerActivity(),
    );
    const res = await svc.listTransactions({ page: 1, limit: 20, player: 'alice' });
    expect(findPlayerIds).toHaveBeenCalledWith('alice');
    expect(listTransactions).toHaveBeenCalledWith(expect.objectContaining({ userIds: ['u-1'] }));
    expect(res.items[0]).toMatchObject({
      rail: 'fiat',
      playerEmail: 'alice@example.com',
    });
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
    expect(res.items[0]).toMatchObject({ playerEmail: null });
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
    const lookupPlayers = vi
      .fn()
      .mockResolvedValue([
        { userId: 'u-1', username: 'alice', email: 'alice@example.com', kycStatus: 'verified' },
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

describe('BackofficeService.getGamePerformance', () => {
  it('converts ISO date filters to Date and passes gameType/sort through to the port', async () => {
    const listGamePerformance = vi.fn().mockResolvedValue([]);
    const svc = new BackofficeService(
      makeUsers(),
      makeReporting(),
      makeGameReporting({ listGamePerformance }),
      makePlayerActivity(),
    );

    await svc.getGamePerformance({
      dateFrom: '2026-01-01T00:00:00.000Z',
      dateTo: '2026-02-01T00:00:00.000Z',
      gameType: 'sportsbook',
      sortBy: 'revenue',
      sortDir: 'asc',
    });

    expect(listGamePerformance).toHaveBeenCalledWith({
      dateFrom: new Date('2026-01-01T00:00:00.000Z'),
      dateTo: new Date('2026-02-01T00:00:00.000Z'),
      gameType: 'sportsbook',
      sortBy: 'revenue',
      sortDir: 'asc',
    });
  });

  it('returns the port rows unchanged (no Date/Decimal fields to serialize)', async () => {
    const rows = [
      {
        gameId: 'g-1',
        name: 'Aces',
        gameType: 'casino' as const,
        volume: '100',
        revenue: '20',
        uniquePlayers: 2,
        roundsPlayed: 5,
      },
    ];
    const svc = new BackofficeService(
      makeUsers(),
      makeReporting(),
      makeGameReporting({ listGamePerformance: vi.fn().mockResolvedValue(rows) }),
      makePlayerActivity(),
    );

    const res = await svc.getGamePerformance({});

    expect(res).toEqual(rows);
  });

  it('leaves dateFrom/dateTo undefined for the port when the filter omits them', async () => {
    const listGamePerformance = vi.fn().mockResolvedValue([]);
    const svc = new BackofficeService(
      makeUsers(),
      makeReporting(),
      makeGameReporting({ listGamePerformance }),
      makePlayerActivity(),
    );

    await svc.getGamePerformance({});

    expect(listGamePerformance).toHaveBeenCalledWith({
      dateFrom: undefined,
      dateTo: undefined,
      gameType: undefined,
      sortBy: undefined,
      sortDir: undefined,
    });
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
