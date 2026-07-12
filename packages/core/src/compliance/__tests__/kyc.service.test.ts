import { describe, it, expect, vi } from 'vitest';
import { KycVerificationService, type KycVerificationDeps } from '../service/kyc.service.js';
import { CumulativeDepositReKycTrigger } from '../service/re-kyc-trigger.js';
import type { DrizzleService } from '@openora/core/server';
import type { KycVendorStatus } from '@openora/core/contracts';
import { mock, mockDb } from '../../testing/mock.js';

// A chainable Drizzle stub: every builder method returns the builder; awaiting it yields
// `selectResult`, while `.returning()` yields `insertResult`.
function makeDb(selectResult: unknown, insertResult: unknown): DrizzleService {
  const builder: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (res: (v: unknown) => unknown) => res(selectResult);
      }
      if (prop === 'returning') {
        return () => Promise.resolve(insertResult);
      }
      return () => builder;
    },
    apply: () => builder,
  });
  return mockDb(builder);
}

function makeEvents() {
  return { emit: vi.fn(), on: vi.fn() };
}

function makeAdapter(status: KycVendorStatus = 'approved') {
  return {
    submit: vi.fn().mockResolvedValue({ referenceId: 'ref-1', status }),
    getStatus: vi.fn().mockResolvedValue(status),
  };
}

function makeWriter() {
  return { setStatus: vi.fn() };
}

function fullRow(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: 'kyc-1',
    userId: 'user-1',
    provider: 'mock',
    referenceId: 'ref-1',
    status: 'pending',
    documentTypes: ['passport'],
    decisionReason: null,
    triggeredBy: 'submission',
    submittedAt: now,
    decidedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function newSvc(opts: {
  db: DrizzleService;
  events?: ReturnType<typeof makeEvents>;
  adapter?: ReturnType<typeof makeAdapter>;
  writer?: ReturnType<typeof makeWriter>;
  config?: unknown;
}) {
  return new KycVerificationService(
    mock<KycVerificationDeps>({
      drizzle: opts.db,
      events: opts.events ?? makeEvents(),
      kycAdapter: opts.adapter ?? makeAdapter(),
      statusWriter: opts.writer ?? makeWriter(),
      platformConfig: opts.config,
    }),
  );
}

describe('KycVerificationService.submit', () => {
  it('inserts a record and emits compliance.kyc.submitted', async () => {
    const events = makeEvents();
    const writer = makeWriter();
    const adapter = makeAdapter('approved');
    const svc = newSvc({
      db: makeDb([], [fullRow({ status: 'verified', decidedAt: new Date() })]),
      events,
      adapter,
      writer,
    });
    const dto = await svc.submit('user-1', { documents: [{ type: 'passport', frontUrl: 'u' }] });
    expect(adapter.submit).toHaveBeenCalledWith('user-1', [
      { type: 'passport', frontUrl: 'u', backUrl: undefined },
    ]);
    expect(events.emit).toHaveBeenCalledWith(
      'compliance.kyc.submitted',
      expect.objectContaining({ userId: 'user-1', referenceId: 'ref-1' }),
    );
    expect(writer.setStatus).toHaveBeenCalledWith(
      'user-1',
      'verified',
      expect.objectContaining({ source: 'vendor' }),
    );
    expect(dto.status).toBe('verified');
  });
});

describe('KycVerificationService.reconcile', () => {
  it('maps vendor approved -> app verified and calls the status writer', async () => {
    const writer = makeWriter();
    const svc = newSvc({
      db: makeDb(
        [fullRow({ status: 'pending', decidedAt: null })],
        [fullRow({ status: 'verified', decidedAt: new Date() })],
      ),
      writer,
    });
    const dto = await svc.reconcile('ref-1', 'approved');
    expect(writer.setStatus).toHaveBeenCalledWith(
      'user-1',
      'verified',
      expect.objectContaining({ source: 'webhook' }),
    );
    expect(dto?.status).toBe('verified');
  });

  it('is idempotent - no writer call when the latest record already holds the mapped status', async () => {
    const writer = makeWriter();
    const svc = newSvc({
      db: makeDb([fullRow({ status: 'verified', decidedAt: new Date() })], []),
      writer,
    });
    await svc.reconcile('ref-1', 'approved');
    expect(writer.setStatus).not.toHaveBeenCalled();
  });
});

describe('KycVerificationService.handleDeposit (threshold re-KYC)', () => {
  const cfg = { kyc: { reverifyThresholds: { USD: '500' } } };

  it('flips a verified player to resubmission_requested once the threshold is crossed', async () => {
    const events = makeEvents();
    const writer = makeWriter();
    const svc = newSvc({
      db: makeDb([{ currency: 'USD', kycStatus: 'verified', total: '1000' }], []),
      events,
      writer,
      config: cfg,
    });
    await svc.handleDeposit('user-1');
    expect(writer.setStatus).toHaveBeenCalledWith(
      'user-1',
      'resubmission_requested',
      expect.objectContaining({ source: 'reverify' }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      'compliance.kyc.reverify_required',
      expect.objectContaining({ userId: 'user-1' }),
    );
  });

  it('does not re-fire once the player is already out of the verified pass-set', async () => {
    const writer = makeWriter();
    const svc = newSvc({
      db: makeDb([{ currency: 'USD', kycStatus: 'resubmission_requested', total: '2000' }], []),
      writer,
      config: cfg,
    });
    await svc.handleDeposit('user-1');
    expect(writer.setStatus).not.toHaveBeenCalled();
  });

  it('does not fire below the threshold', async () => {
    const writer = makeWriter();
    const svc = newSvc({
      db: makeDb([{ currency: 'USD', kycStatus: 'verified', total: '100' }], []),
      writer,
      config: cfg,
    });
    await svc.handleDeposit('user-1');
    expect(writer.setStatus).not.toHaveBeenCalled();
  });
});

describe('CumulativeDepositReKycTrigger', () => {
  const trigger = new CumulativeDepositReKycTrigger();

  it('fires on the first crossing at or above the per-currency threshold', () => {
    expect(
      trigger.requiresReverify(
        { totalDeposits: '500', currency: 'USD', lastTriggeredDeposits: '0' },
        { USD: '500' },
      ),
    ).toBe(true);
    expect(
      trigger.requiresReverify(
        { totalDeposits: '900', currency: 'USD', lastTriggeredDeposits: '0' },
        { USD: '500' },
      ),
    ).toBe(true);
  });

  it('does not re-fire within the same band, but fires again on a fresh band (watermark)', () => {
    expect(
      trigger.requiresReverify(
        { totalDeposits: '950', currency: 'USD', lastTriggeredDeposits: '900' },
        { USD: '500' },
      ),
    ).toBe(false);
    expect(
      trigger.requiresReverify(
        { totalDeposits: '1000', currency: 'USD', lastTriggeredDeposits: '900' },
        { USD: '500' },
      ),
    ).toBe(true);
  });

  it('does not fire below the threshold or when the currency has none', () => {
    expect(
      trigger.requiresReverify(
        { totalDeposits: '100', currency: 'USD', lastTriggeredDeposits: '0' },
        { USD: '500' },
      ),
    ).toBe(false);
    expect(
      trigger.requiresReverify(
        { totalDeposits: '9999', currency: 'EUR', lastTriggeredDeposits: '0' },
        { USD: '500' },
      ),
    ).toBe(false);
    expect(
      trigger.requiresReverify(
        { totalDeposits: '9999', currency: 'USD', lastTriggeredDeposits: '0' },
        undefined,
      ),
    ).toBe(false);
  });
});
