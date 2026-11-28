import { vi, type Mock } from 'vitest';
import type { EventBus } from '@openora/core/server';
import {
  DEFAULT_PAYMENT_PROVIDER,
  type AuditWritePort,
  type IdentityReader,
  type KycWithdrawalPolicy,
  type PaymentAdapter,
  type PaymentProviderRegistry,
  type PaymentWebhookVerifier,
  type PlayerTags,
  type WithdrawalSecurity,
} from '@openora/core/contracts';

export const mock = <T>(partial: object = {}): T => partial as unknown as T;

type MockedEventBus = EventBus & { emit: Mock; on: Mock; emitInTransaction: Mock };

export const makeEventBus = (): MockedEventBus =>
  mock<MockedEventBus>({ emit: vi.fn(), on: vi.fn(), emitInTransaction: vi.fn() });

export const makeAuditWriter = (): AuditWritePort & {
  record: Mock;
  recordInTransaction: Mock;
  recordManyInTransaction: Mock;
} => ({
  auditedTopics: new Set<string>(),
  record: vi.fn(async () => undefined),
  recordInTransaction: vi.fn(async () => undefined),
  recordManyInTransaction: vi.fn(async () => undefined),
});

export const makeWithdrawalPorts = (): {
  riskTags: PlayerTags;
  kycPolicy: KycWithdrawalPolicy;
  withdrawalSecurity: WithdrawalSecurity;
} => ({
  riskTags: { getActiveTagKeys: vi.fn(async () => new Map()) },
  kycPolicy: { requiresKycForWithdrawal: vi.fn(async () => true) },
  withdrawalSecurity: {
    verifyPin: vi.fn<WithdrawalSecurity['verifyPin']>(async () => ({ status: 'not_set' })),
    pinLockedUntil: vi.fn<WithdrawalSecurity['pinLockedUntil']>(async () => null),
    assertReauthentication: vi.fn<WithdrawalSecurity['assertReauthentication']>(
      async () => undefined,
    ),
  },
});

export const makePaymentProviderRegistry = (
  adapter: PaymentAdapter = mock<PaymentAdapter>(),
): PaymentProviderRegistry => {
  const webhookVerifier = mock<PaymentWebhookVerifier>({ verify: vi.fn(() => false) });
  return {
    get: (name) => (name === DEFAULT_PAYMENT_PROVIDER ? { adapter, webhookVerifier } : null),
    names: () => [DEFAULT_PAYMENT_PROVIDER],
  };
};

export const makeIdentityReader = (): IdentityReader =>
  mock<IdentityReader>({
    getPlayerIdByUserIdSafe: vi.fn().mockResolvedValue(null),
    getPlayerIdsByUserIdsSafe: vi.fn().mockResolvedValue(new Map()),
  });
