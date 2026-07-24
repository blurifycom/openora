import { describe, it, expect, vi } from 'vitest';
import { call, ORPCError } from '@orpc/server';
import { mock, adminCaller, testContext } from '../../testing/mock.js';
import type { AdminGuard } from '@openora/core/server';
import type {
  AuditWritePort,
  PaymentAdapter,
  PaymentWebhookVerifier,
} from '@openora/core/contracts';
import { createWalletRouter } from '../router/index.js';
import type { WalletService } from '../service/wallet.service.js';

const CTX = testContext();
const USER_ID = '63d3c264-3bf4-4d08-9b92-ea3eaf40a440';
const RULE = {
  id: '1f6d1b2c-0000-4000-8000-000000000001',
  userId: USER_ID,
  threshold: '500',
  reason: 'trusted',
  createdBy: '9a2f7c11-0000-4000-8000-0000000000aa',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function fakeWallet(over: Partial<WalletService> = {}): WalletService {
  return mock<WalletService>({
    setAutoWithdrawalRule: vi.fn().mockResolvedValue(RULE),
    getAutoWithdrawalRule: vi.fn().mockResolvedValue(RULE),
    deleteAutoWithdrawalRule: vi.fn().mockResolvedValue(true),
    ...over,
  });
}

function allowingGuard(): AdminGuard {
  return mock<AdminGuard>({ assert: vi.fn(async () => adminCaller({ userId: 'caller-1' })) });
}

// Grants everything except `withdrawal:auto-rule`.
function autoRuleDenyingGuard(): AdminGuard {
  return mock<AdminGuard>({
    assert: vi.fn(async (_ctx: unknown, resource?: string, action?: string) => {
      if (resource === 'withdrawal' && action === 'auto-rule') {
        throw new ORPCError('FORBIDDEN', { message: 'Missing permission: withdrawal:auto-rule' });
      }
      return adminCaller({ userId: 'caller-1', role: 'support' });
    }),
  });
}

const fakeAudit = () => mock<AuditWritePort>({ record: vi.fn() });
const fakePayment = (): PaymentAdapter => mock<PaymentAdapter>({});
const fakeWebhookVerifier = (): PaymentWebhookVerifier =>
  mock<PaymentWebhookVerifier>({ verify: vi.fn().mockReturnValue(false) });

describe('wallet auto-withdrawal-rule routes', () => {
  it('set: creates the rule and writes an admin audit entry', async () => {
    const wallet = fakeWallet();
    const audit = fakeAudit();
    const router = createWalletRouter(
      wallet,
      allowingGuard(),
      audit,
      fakePayment(),
      fakeWebhookVerifier(),
    );

    const result = await call(
      router.autoWithdrawalRules.set,
      { userId: USER_ID, threshold: '500', reason: 'trusted' },
      { context: CTX },
    );

    expect(result).toEqual(RULE);
    expect(wallet.setAutoWithdrawalRule).toHaveBeenCalledWith({
      userId: USER_ID,
      threshold: '500',
      reason: 'trusted',
      createdBy: 'caller-1',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'admin',
        action: 'wallet.auto_withdrawal_rule.set',
        resourceType: 'auto_withdrawal_rule',
        resourceId: USER_ID,
        after: { threshold: '500', reason: 'trusted' },
      }),
    );
  });

  it('set: rejects a caller lacking withdrawal:auto-rule', async () => {
    const wallet = fakeWallet();
    const audit = fakeAudit();
    const router = createWalletRouter(
      wallet,
      autoRuleDenyingGuard(),
      audit,
      fakePayment(),
      fakeWebhookVerifier(),
    );

    await expect(
      call(
        router.autoWithdrawalRules.set,
        { userId: USER_ID, threshold: '500', reason: 'trusted' },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(wallet.setAutoWithdrawalRule).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('delete: removes the rule and writes an admin audit entry', async () => {
    const wallet = fakeWallet();
    const audit = fakeAudit();
    const router = createWalletRouter(
      wallet,
      allowingGuard(),
      audit,
      fakePayment(),
      fakeWebhookVerifier(),
    );

    const result = await call(
      router.autoWithdrawalRules.delete,
      { userId: USER_ID },
      { context: CTX },
    );

    expect(result).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'wallet.auto_withdrawal_rule.deleted',
        resourceId: USER_ID,
      }),
    );
  });

  it('delete: rejects a caller lacking withdrawal:auto-rule', async () => {
    const wallet = fakeWallet();
    const router = createWalletRouter(
      wallet,
      autoRuleDenyingGuard(),
      fakeAudit(),
      fakePayment(),
      fakeWebhookVerifier(),
    );

    await expect(
      call(router.autoWithdrawalRules.delete, { userId: USER_ID }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(wallet.deleteAutoWithdrawalRule).not.toHaveBeenCalled();
  });

  it('get: returns the rule for an authorized caller', async () => {
    const wallet = fakeWallet();
    const router = createWalletRouter(
      wallet,
      allowingGuard(),
      fakeAudit(),
      fakePayment(),
      fakeWebhookVerifier(),
    );

    const result = await call(
      router.autoWithdrawalRules.get,
      { userId: USER_ID },
      { context: CTX },
    );

    expect(result).toEqual(RULE);
  });

  it('get: rejects a caller lacking withdrawal:auto-rule', async () => {
    const wallet = fakeWallet();
    const router = createWalletRouter(
      wallet,
      autoRuleDenyingGuard(),
      fakeAudit(),
      fakePayment(),
      fakeWebhookVerifier(),
    );

    await expect(
      call(router.autoWithdrawalRules.get, { userId: USER_ID }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(wallet.getAutoWithdrawalRule).not.toHaveBeenCalled();
  });
});
