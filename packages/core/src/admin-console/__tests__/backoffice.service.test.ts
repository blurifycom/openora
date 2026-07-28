import { describe, it, expect, vi } from 'vitest';
import { mock } from '../../testing/mock.js';
import type {
  AdminTxDetail,
  AdminTxRow,
  AdminUserDirectory,
  AdminWalletReporting,
} from '@openora/core/contracts';
import { BackofficeService, TransactionNotFoundError } from '../service/backoffice.service.js';

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
    );
    const res = await svc.listTransactions({ page: 1, limit: 20, player: 'ghost' });
    expect(res).toEqual({ items: [], total: 0, page: 1, limit: 20 });
    expect(listTransactions).not.toHaveBeenCalled();
  });

  it('leaves player fields null when enrichment does not resolve a row', async () => {
    const listTransactions = vi.fn().mockResolvedValue({ rows: [txRow()], total: 1 });
    const svc = new BackofficeService(makeUsers(), makeReporting({ listTransactions }));
    const res = await svc.listTransactions({ page: 1, limit: 20 });
    expect(res.items[0]).toMatchObject({ playerEmail: null });
  });

  it('converts ISO date filters to Date for the port', async () => {
    const listTransactions = vi.fn().mockResolvedValue({ rows: [], total: 0 });
    const svc = new BackofficeService(makeUsers(), makeReporting({ listTransactions }));
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
    const svc = new BackofficeService(makeUsers(), makeReporting());
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
    );
    const res = await svc.getTransaction('tx-1');
    expect(res.reviewedAt).toBeNull();
  });
});
