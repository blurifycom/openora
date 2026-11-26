import { vi, type Mock } from 'vitest';
import type {
  AuditWritePort,
  PlayEligibilityPort,
  WalletBalancesReading,
  WalletReader,
} from '@openora/core/contracts';
import type { EventBus } from '@openora/core/server';

export type MockedAuditWriter = AuditWritePort & {
  record: Mock;
  recordInTransaction: Mock;
  recordManyInTransaction: Mock;
};

export const makeAuditWriter = (): MockedAuditWriter => ({
  auditedTopics: new Set<string>(),
  record: vi.fn(async () => undefined),
  recordInTransaction: vi.fn(async () => undefined),
  recordManyInTransaction: vi.fn(async () => undefined),
});

export const makeEventBus = (): EventBus => ({
  emit: vi.fn(),
  emitRaw: vi.fn(),
  emitInTransaction: vi.fn(async () => undefined),
  on: () => () => undefined,
  tapTransactional: () => undefined,
});

export const unrestricted: PlayEligibilityPort = { isRestricted: async () => false };

const unused = async (): Promise<never> => {
  throw new Error('not used by the bonus engine under test');
};

export const makeWalletReader = (
  getBalances: () => Promise<WalletBalancesReading> = unused,
): WalletReader => ({
  getLifetimeDeposit: async () => '0',
  isFirstDeposit: async () => true,
  getBalances,
  getWithdrawalCountInWindow: unused,
  getDepositsByCurrency: unused,
  getMoneyByWindow: unused,
  hasWallet: unused,
  sumProviderTransactions: unused,
});
