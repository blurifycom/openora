import { describe, it, expect, vi } from 'vitest';
import { call, ORPCError } from '@orpc/server';
import { mock } from '../../testing/mock.js';
import type { AdminGuard } from '@openora/core/server';
import type {
  AuditWritePort,
  PaymentAdapter,
  PaymentWebhookEvent,
  PaymentWebhookVerifier,
} from '@openora/core/contracts';
import { createWalletRouter } from '../router/index.js';
import type { WalletService } from '../service/wallet.service.js';

const fakeAudit = (): AuditWritePort => mock<AuditWritePort>({ record: vi.fn() });
const fakeGuard = (): AdminGuard => mock<AdminGuard>({ assert: vi.fn() });

function fakeWallet(): WalletService {
  return mock<WalletService>({
    creditDepositByAddress: vi.fn().mockResolvedValue(undefined),
    reconcileWithdrawalStatus: vi.fn().mockResolvedValue(undefined),
  });
}

function ctx(rawBody: string, headers: Record<string, string> = {}) {
  return { context: { request: { headers }, rawBody } };
}

describe('wallet webhook route (M2M, no admin session)', () => {
  it('rejects when the signature verifier fails (fail closed)', async () => {
    const wallet = fakeWallet();
    const payment = mock<PaymentAdapter>({ parseWebhook: vi.fn() });
    const verifier = mock<PaymentWebhookVerifier>({ verify: vi.fn().mockReturnValue(false) });
    const router = createWalletRouter(wallet, fakeGuard(), fakeAudit(), payment, verifier);

    await expect(
      call(router.webhook, {}, ctx('{}', { 'x-payment-signature': 'bad' })),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(payment.parseWebhook).not.toHaveBeenCalled();
    expect(wallet.creditDepositByAddress).not.toHaveBeenCalled();
  });

  it('rejects when no raw body was captured', async () => {
    const wallet = fakeWallet();
    const payment = mock<PaymentAdapter>({ parseWebhook: vi.fn() });
    const verifier = mock<PaymentWebhookVerifier>({ verify: vi.fn().mockReturnValue(true) });
    const router = createWalletRouter(wallet, fakeGuard(), fakeAudit(), payment, verifier);

    await expect(
      call(router.webhook, {}, { context: { request: { headers: {} } } }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('dispatches a verified deposit event to creditDepositByAddress', async () => {
    const wallet = fakeWallet();
    const event: PaymentWebhookEvent = {
      kind: 'deposit',
      address: 'bc1qxyz',
      amount: '0.5',
      currency: 'BTC',
      txHash: '0xabc',
      externalId: 'vendor-ext-1',
    };
    const payment = mock<PaymentAdapter>({ parseWebhook: vi.fn().mockReturnValue(event) });
    const verifier = mock<PaymentWebhookVerifier>({ verify: vi.fn().mockReturnValue(true) });
    const router = createWalletRouter(wallet, fakeGuard(), fakeAudit(), payment, verifier);

    const result = await call(router.webhook, {}, ctx('{"event":"deposit"}'));

    expect(result).toEqual({ ok: true });
    expect(wallet.creditDepositByAddress).toHaveBeenCalledWith(event);
    expect(wallet.reconcileWithdrawalStatus).not.toHaveBeenCalled();
  });

  it('dispatches a verified withdrawal event to reconcileWithdrawalStatus', async () => {
    const wallet = fakeWallet();
    const event: PaymentWebhookEvent = {
      kind: 'withdrawal',
      externalId: 'vendor-ext-2',
      status: 'completed',
    };
    const payment = mock<PaymentAdapter>({ parseWebhook: vi.fn().mockReturnValue(event) });
    const verifier = mock<PaymentWebhookVerifier>({ verify: vi.fn().mockReturnValue(true) });
    const router = createWalletRouter(wallet, fakeGuard(), fakeAudit(), payment, verifier);

    const result = await call(router.webhook, {}, ctx('{"event":"withdrawal"}'));

    expect(result).toEqual({ ok: true });
    expect(wallet.reconcileWithdrawalStatus).toHaveBeenCalledWith(event);
    expect(wallet.creditDepositByAddress).not.toHaveBeenCalled();
  });

  it('returns ok without dispatching when parseWebhook does not recognize the body', async () => {
    const wallet = fakeWallet();
    const payment = mock<PaymentAdapter>({ parseWebhook: vi.fn().mockReturnValue(null) });
    const verifier = mock<PaymentWebhookVerifier>({ verify: vi.fn().mockReturnValue(true) });
    const router = createWalletRouter(wallet, fakeGuard(), fakeAudit(), payment, verifier);

    const result = await call(router.webhook, {}, ctx('{"event":"unknown"}'));

    expect(result).toEqual({ ok: true });
    expect(wallet.creditDepositByAddress).not.toHaveBeenCalled();
    expect(wallet.reconcileWithdrawalStatus).not.toHaveBeenCalled();
  });
});
