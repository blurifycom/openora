import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mock, readPrivate, makeDrizzle, makeEvents, makePayment } from '../../testing/mock.js';
import type { AutoWithdrawalConfig } from '@openora/core/contracts';
import { WalletService } from '../service/wallet.service.js';

type Row = Record<string, unknown>;

const makeAudit = () => ({ record: vi.fn().mockResolvedValue(undefined) });

const WALLET_ROW = { id: 'w-1', userId: 'u-1', balance: '100000', currency: 'USD' };
const insertRow = (over: Row = {}) => ({
  id: 'tx-1',
  walletId: 'w-1',
  amount: '40',
  currency: 'USD',
  status: 'pending',
  rail: 'fiat',
  ...over,
});

// select/returning rows the initial hold transaction always consumes (no idempotency key).
const holdSelect = (wallet: Row = WALLET_ROW) => [wallet];
const holdReturning = (tx: Row = insertRow()) => [[tx], [{ id: 'w-1' }]];

// select/returning rows the flipToProcessing + settleApproved path consumes on a successful settle.
const finalizeSelect = () => [
  [
    {
      id: 'tx-1',
      walletId: 'w-1',
      type: 'withdrawal',
      status: 'pending',
      amount: '40',
      currency: 'USD',
    },
  ],
  [{ userId: 'u-1' }],
  [],
];
const finalizeReturning = () => [
  [
    {
      id: 'tx-1',
      walletId: 'w-1',
      type: 'withdrawal',
      status: 'processing',
      amount: '40',
      currency: 'USD',
      rail: 'fiat',
    },
  ],
];

type Opts = {
  drizzle: ReturnType<typeof makeDrizzle>;
  directory?: { lookupPlayers: ReturnType<typeof vi.fn> };
  riskTags?: { getActiveTagKeys: ReturnType<typeof vi.fn> };
  autoWithdrawal?: Partial<AutoWithdrawalConfig>;
  kyc?: Record<string, unknown>;
};

function makeSvc(opts: Opts) {
  const events = makeEvents();
  const payment = makePayment();
  const audit = makeAudit();
  const platformConfig = {
    ...(opts.kyc ? { kyc: opts.kyc } : {}),
    ...(opts.autoWithdrawal
      ? { autoWithdrawal: { enabled: true, excludeRiskFlags: [], ...opts.autoWithdrawal } }
      : {}),
  };
  const svc = new WalletService(
    mock<ConstructorParameters<typeof WalletService>[0]>({
      drizzle: opts.drizzle,
      events,
      payment,
      directory: opts.directory,
      riskTags: opts.riskTags,
      audit,
      platformConfig,
    }),
  );
  return { svc, events, payment, audit };
}

const verifiedDirectory = () => ({
  lookupPlayers: vi.fn().mockResolvedValue([{ userId: 'u-1', kycStatus: 'verified' }]),
});

describe('WalletService.withdraw auto-approval', () => {
  beforeEach(() => vi.clearAllMocks());

  it('auto-approves a fiat withdrawal that passes every gate, reusing the approve/settle path', async () => {
    const dz = makeDrizzle({
      select: [
        ...holdSelect().map((r) => [r]),
        [], // resolveAutoThreshold: no per-player rule -> falls back to global (pre-lock)
        [{ walletId: 'w-1', n: 1 }], // velocity grouped count (< 3), pre-lock
        [{ total: '0', n: 0 }], // caps, inside the advisory lock
        ...finalizeSelect(),
      ],
      returning: [...holdReturning(), ...finalizeReturning()],
    });
    const setSpy = readPrivate<ReturnType<typeof vi.fn>>(dz.db, 'set');
    const { svc, payment, audit } = makeSvc({
      drizzle: dz,
      directory: verifiedDirectory(),
      autoWithdrawal: { fiatThreshold: 1000 },
    });

    const result = await svc.withdraw({ userId: 'u-1', amount: 40, currency: 'USD' });

    expect(result).toEqual({ transactionId: 'tx-1', status: 'completed' });
    expect(payment.processWithdrawal).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reviewReason: 'auto-approved', reviewedBy: null }),
    );
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', providerRefId: 'ext-2' }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'system',
        action: 'wallet.withdrawal.auto_approved',
        resourceType: 'wallet_transaction',
        resourceId: 'tx-1',
        after: expect.objectContaining({
          threshold: 1000,
          thresholdSource: 'global',
          kycStatus: 'verified',
          riskTagsEvaluated: [],
        }),
      }),
    );
  });

  it('takes a per-user advisory lock before the cap check + auto-approval flip', async () => {
    // The mock can't reproduce advisory-lock serialization, so instead prove the invariant it relies on:
    // pg_advisory_xact_lock is acquired before the flip that writes the marker the next caller's cap query reads.
    const dz = makeDrizzle({
      select: [
        ...holdSelect().map((r) => [r]),
        [], // resolveAutoThreshold -> global fallback
        [{ n: 1 }], // velocity
        [{ total: '0', n: 0 }], // caps
        ...finalizeSelect(),
      ],
      returning: [...holdReturning(), ...finalizeReturning()],
    });
    const setSpy = readPrivate<ReturnType<typeof vi.fn>>(dz.db, 'set');
    const executeSpy = readPrivate<ReturnType<typeof vi.fn>>(dz.db, 'execute');
    const { svc } = makeSvc({
      drizzle: dz,
      directory: verifiedDirectory(),
      autoWithdrawal: { fiatThreshold: 1000, dailyCapCount: 1 },
    });

    await svc.withdraw({ userId: 'u-1', amount: 40, currency: 'USD' });

    expect(executeSpy).toHaveBeenCalledTimes(1);
    const lockOrder = executeSpy.mock.invocationCallOrder[0]!;
    // The lock must precede the flip `.set()` that writes the auto-approved marker (and the cap read between them).
    const flipCallIndex = setSpy.mock.calls.findIndex(
      ([arg]) => (arg as { reviewReason?: string })?.reviewReason === 'auto-approved',
    );
    expect(flipCallIndex).toBeGreaterThanOrEqual(0);
    const flipOrder = setSpy.mock.invocationCallOrder[flipCallIndex]!;
    expect(lockOrder).toBeLessThan(flipOrder);
  });

  it('reverts the flip to pending when the audit write fails, instead of leaving it stuck processing', async () => {
    const dz = makeDrizzle({
      select: [
        ...holdSelect().map((r) => [r]),
        [], // resolveAutoThreshold -> global fallback
        [{ n: 1 }], // velocity
        [{ total: '0', n: 0 }], // caps
        [
          {
            id: 'tx-1',
            walletId: 'w-1',
            type: 'withdrawal',
            status: 'pending',
            amount: '40',
            currency: 'USD',
          },
        ], // flipToProcessing's FOR UPDATE select
      ],
      returning: [
        ...holdReturning(),
        [
          {
            id: 'tx-1',
            walletId: 'w-1',
            status: 'processing',
            amount: '40',
            currency: 'USD',
            rail: 'fiat',
          },
        ], // flipToProcessing's update...returning
      ],
    });
    const setSpy = readPrivate<ReturnType<typeof vi.fn>>(dz.db, 'set');
    const { svc, audit, payment } = makeSvc({
      drizzle: dz,
      directory: verifiedDirectory(),
      autoWithdrawal: { fiatThreshold: 1000 },
    });
    audit.record.mockRejectedValueOnce(new Error('audit down'));

    const result = await svc.withdraw({ userId: 'u-1', amount: 40, currency: 'USD' });

    expect(result).toEqual({ transactionId: 'tx-1', status: 'pending' });
    expect(payment.processWithdrawal).not.toHaveBeenCalled();
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'processing', reviewReason: 'auto-approved' }),
    );
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending',
        reviewedBy: null,
        reviewedAt: null,
        reviewReason: null,
      }),
    );
  });

  it('stays pending when KYC is not passing even though kyc.gateWithdrawals is false', async () => {
    const dz = makeDrizzle({
      select: [...holdSelect().map((r) => [r]), []],
      returning: [...holdReturning()],
    });
    const { svc, payment } = makeSvc({
      drizzle: dz,
      directory: {
        lookupPlayers: vi.fn().mockResolvedValue([{ userId: 'u-1', kycStatus: 'pending' }]),
      },
      kyc: { gateWithdrawals: false },
      autoWithdrawal: { fiatThreshold: 1000 },
    });

    const result = await svc.withdraw({ userId: 'u-1', amount: 40, currency: 'USD' });

    expect(result.status).toBe('pending');
    expect(payment.processWithdrawal).not.toHaveBeenCalled();
  });

  it('stays pending when the player carries an excluded risk flag', async () => {
    const dz = makeDrizzle({
      select: [...holdSelect().map((r) => [r]), []],
      returning: [...holdReturning()],
    });
    const { svc, payment } = makeSvc({
      drizzle: dz,
      directory: verifiedDirectory(),
      riskTags: {
        getActiveTagKeys: vi.fn().mockResolvedValue(new Map([['u-1', ['high_risk']]])),
      },
      autoWithdrawal: { fiatThreshold: 1000, excludeRiskFlags: ['high_risk'] },
    });

    const result = await svc.withdraw({ userId: 'u-1', amount: 40, currency: 'USD' });

    expect(result.status).toBe('pending');
    expect(payment.processWithdrawal).not.toHaveBeenCalled();
  });

  it('stays pending on a high_frequency velocity flag', async () => {
    const dz = makeDrizzle({
      // grouped velocity count returns the wallet with >= 3 withdrawals in the window
      select: [...holdSelect().map((r) => [r]), [], [{ walletId: 'w-1', n: 3 }]],
      returning: [...holdReturning()],
    });
    const { svc, payment } = makeSvc({
      drizzle: dz,
      directory: verifiedDirectory(),
      autoWithdrawal: { fiatThreshold: 1000 },
    });

    const result = await svc.withdraw({ userId: 'u-1', amount: 40, currency: 'USD' });

    expect(result.status).toBe('pending');
    expect(payment.processWithdrawal).not.toHaveBeenCalled();
  });

  it('stays pending when a configured daily count cap would be exceeded', async () => {
    const dz = makeDrizzle({
      select: [...holdSelect().map((r) => [r]), [], [{ n: 1 }], [{ total: '0', n: 1 }]],
      returning: [...holdReturning()],
    });
    const { svc, payment } = makeSvc({
      drizzle: dz,
      directory: verifiedDirectory(),
      autoWithdrawal: { fiatThreshold: 1000, dailyCapCount: 1 },
    });

    const result = await svc.withdraw({ userId: 'u-1', amount: 40, currency: 'USD' });

    expect(result.status).toBe('pending');
    expect(payment.processWithdrawal).not.toHaveBeenCalled();
  });

  it('stays pending when a configured daily amount cap would be exceeded', async () => {
    const dz = makeDrizzle({
      select: [...holdSelect().map((r) => [r]), [], [{ n: 1 }], [{ total: '80', n: 1 }]],
      returning: [...holdReturning()],
    });
    const { svc, payment } = makeSvc({
      drizzle: dz,
      directory: verifiedDirectory(),
      autoWithdrawal: { fiatThreshold: 1000, dailyCapAmount: 100 },
    });

    const result = await svc.withdraw({ userId: 'u-1', amount: 40, currency: 'USD' });

    expect(result.status).toBe('pending');
    expect(payment.processWithdrawal).not.toHaveBeenCalled();
  });

  it('fails closed to pending when risk flags are configured but PLAYER_TAGS is unbound', async () => {
    const dz = makeDrizzle({
      select: [...holdSelect().map((r) => [r]), []],
      returning: [...holdReturning()],
    });
    const { svc, payment } = makeSvc({
      drizzle: dz,
      directory: verifiedDirectory(),
      autoWithdrawal: { fiatThreshold: 1000, excludeRiskFlags: ['high_risk'] },
    });

    const result = await svc.withdraw({ userId: 'u-1', amount: 40, currency: 'USD' });

    expect(result.status).toBe('pending');
    expect(payment.processWithdrawal).not.toHaveBeenCalled();
  });

  it('fails closed to pending when the directory throws during the KYC check', async () => {
    const dz = makeDrizzle({
      select: [...holdSelect().map((r) => [r]), []],
      returning: [...holdReturning()],
    });
    const { svc, payment } = makeSvc({
      drizzle: dz,
      directory: { lookupPlayers: vi.fn().mockRejectedValue(new Error('directory down')) },
      autoWithdrawal: { fiatThreshold: 1000 },
    });

    const result = await svc.withdraw({ userId: 'u-1', amount: 40, currency: 'USD' });

    expect(result.status).toBe('pending');
    expect(payment.processWithdrawal).not.toHaveBeenCalled();
  });

  it('never auto-approves the crypto rail regardless of config', async () => {
    const dz = makeDrizzle({
      select: [[{ id: 'w-1', userId: 'u-1', balance: '100', currency: 'BTC' }]],
      returning: [
        [{ id: 'tx-1', walletId: 'w-1', amount: '1', currency: 'BTC', status: 'pending' }],
        [{ id: 'w-1' }],
      ],
    });
    const directory = verifiedDirectory();
    const { svc, payment } = makeSvc({
      drizzle: dz,
      directory,
      autoWithdrawal: { fiatThreshold: 1_000_000 },
    });

    const result = await svc.withdraw({ userId: 'u-1', amount: 1, currency: 'BTC' });

    expect(result.status).toBe('pending');
    expect(payment.processWithdrawal).not.toHaveBeenCalled();
    // Crypto is hard-stopped before any KYC/risk resolution.
    expect(directory.lookupPlayers).not.toHaveBeenCalled();
  });

  it('stays pending when no threshold is configured (no per-player rule, no global)', async () => {
    const dz = makeDrizzle({
      select: [...holdSelect().map((r) => [r]), []],
      returning: [...holdReturning()],
    });
    const { svc, payment } = makeSvc({
      drizzle: dz,
      directory: verifiedDirectory(),
      autoWithdrawal: {}, // enabled, but no fiatThreshold
    });

    const result = await svc.withdraw({ userId: 'u-1', amount: 40, currency: 'USD' });

    expect(result.status).toBe('pending');
    expect(payment.processWithdrawal).not.toHaveBeenCalled();
  });

  it('per-player rule below the global threshold blocks what global would allow', async () => {
    const dz = makeDrizzle({
      select: [
        ...holdSelect().map((r) => [r]),
        [{ id: 'r-1', userId: 'u-1', threshold: '10', reason: 'watch', createdBy: 'a-1' }],
      ],
      returning: [...holdReturning()],
    });
    const { svc, payment } = makeSvc({
      drizzle: dz,
      directory: verifiedDirectory(),
      autoWithdrawal: { fiatThreshold: 1000 },
    });

    const result = await svc.withdraw({ userId: 'u-1', amount: 40, currency: 'USD' });

    expect(result.status).toBe('pending');
    expect(payment.processWithdrawal).not.toHaveBeenCalled();
  });

  it('per-player rule above the global threshold allows what global would block', async () => {
    const dz = makeDrizzle({
      select: [
        ...holdSelect().map((r) => [r]),
        [{ id: 'r-1', userId: 'u-1', threshold: '1000', reason: 'trusted', createdBy: 'a-1' }],
        [{ n: 1 }],
        [{ total: '0', n: 0 }],
        ...finalizeSelect(),
      ],
      returning: [...holdReturning(), ...finalizeReturning()],
    });
    const { svc, payment, audit } = makeSvc({
      drizzle: dz,
      directory: verifiedDirectory(),
      autoWithdrawal: { fiatThreshold: 10 },
    });

    const result = await svc.withdraw({ userId: 'u-1', amount: 40, currency: 'USD' });

    expect(result.status).toBe('completed');
    expect(payment.processWithdrawal).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        after: expect.objectContaining({ threshold: 1000, thresholdSource: 'per-player' }),
      }),
    );
  });
});

describe('WalletService auto-withdrawal rule methods', () => {
  beforeEach(() => vi.clearAllMocks());

  it('setAutoWithdrawalRule upserts and returns the rule with a numeric threshold', async () => {
    const dz = makeDrizzle({
      returning: [
        [
          {
            id: 'r-1',
            userId: 'u-1',
            threshold: '500',
            reason: 'trusted',
            createdBy: 'a-1',
            createdAt: new Date('2026-01-01T00:00:00Z'),
            updatedAt: new Date('2026-01-01T00:00:00Z'),
          },
        ],
      ],
    });
    const { svc } = makeSvc({ drizzle: dz });

    const rule = await svc.setAutoWithdrawalRule({
      userId: 'u-1',
      threshold: 500,
      reason: 'trusted',
      createdBy: 'a-1',
    });

    expect(rule).toMatchObject({ id: 'r-1', userId: 'u-1', threshold: 500, reason: 'trusted' });
    expect(typeof rule.createdAt).toBe('string');
  });

  it('getAutoWithdrawalRule returns null when no rule exists', async () => {
    const dz = makeDrizzle({ select: [[]] });
    const { svc } = makeSvc({ drizzle: dz });
    expect(await svc.getAutoWithdrawalRule('u-1')).toBeNull();
  });

  it('deleteAutoWithdrawalRule reports whether a row was removed', async () => {
    const dz = makeDrizzle({ returning: [[{ id: 'r-1' }]] });
    const { svc } = makeSvc({ drizzle: dz });
    expect(await svc.deleteAutoWithdrawalRule('u-1')).toBe(true);

    const empty = makeDrizzle({ returning: [[]] });
    const { svc: svc2 } = makeSvc({ drizzle: empty });
    expect(await svc2.deleteAutoWithdrawalRule('u-1')).toBe(false);
  });
});
