import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  KYC_STATUSES,
  MIN_PLAYER_AGE_YEARS,
  isAdultDateOfBirth,
  type KycCheckResult,
  type KycStatus,
} from '@openora/core/contracts';
import type { PlayerKycView } from '../../contract/index.js';
import {
  gateVendorDecision,
  isDecided,
  resolveManualStatus,
  toPlayerSummaryView,
} from '../kyc.service.js';

const adult = { underage: false, unreadable: false };
const approvedChecks: KycCheckResult[] = [
  { step: 'ID_VERIFICATION', status: 'approved' },
  { step: 'LIVENESS', status: 'approved' },
];

describe('isAdultDateOfBirth', () => {
  const now = new Date('2026-06-15T12:00:00Z');

  it.each([
    ['exactly on the 18th birthday', '2008-06-15', true],
    ['the day before the 18th birthday', '2008-06-16', false],
    ['the day after the 18th birthday', '2008-06-14', true],
    ['one year younger', '2009-06-15', false],
    ['leap-day birth on 18th-year non-leap day', '2008-02-29', true],
  ])('%s', (_name, dob, expected) => {
    expect(isAdultDateOfBirth(dob, now)).toBe(expected);
  });

  it('defaults to the platform minimum age', () => {
    expect(MIN_PLAYER_AGE_YEARS).toBe(18);
  });

  it('honours a stricter configured minimum age', () => {
    expect(isAdultDateOfBirth('2008-06-15', now, 21)).toBe(false);
    expect(isAdultDateOfBirth('2005-06-15', now, 21)).toBe(true);
  });

  it('evaluates the birthday in UTC, not the host timezone', () => {
    expect(isAdultDateOfBirth('2008-06-15', new Date('2026-06-14T23:59:59Z'))).toBe(false);
    expect(isAdultDateOfBirth('2008-06-15', new Date('2026-06-15T00:00:00Z'))).toBe(true);
    expect(isAdultDateOfBirth('2008-06-15', new Date('2026-06-15T23:59:59Z'))).toBe(true);
  });

  it('agrees with a zero-padded date string comparison for any date of birth', () => {
    const isoDate = fc
      .date({
        min: new Date('1900-01-01T00:00:00Z'),
        max: new Date('2030-12-31T00:00:00Z'),
        noInvalidDate: true,
      })
      .map((date) => date.toISOString().slice(0, 10));
    fc.assert(
      fc.property(isoDate, isoDate, fc.integer({ min: 18, max: 30 }), (dob, today, minAge) => {
        const cutoff = `${Number(today.slice(0, 4)) - minAge}`.padStart(4, '0') + today.slice(4);
        expect(isAdultDateOfBirth(dob, new Date(`${today}T00:00:00Z`), minAge)).toBe(dob <= cutoff);
      }),
    );
  });
});

describe('gateVendorDecision', () => {
  it('rejects an underage player as underage whatever the vendor said', () => {
    for (const vendor of ['approved', 'rejected', 'pending', 'not_started'] as const) {
      expect(
        gateVendorDecision(vendor, approvedChecks, { underage: true, unreadable: false }),
      ).toEqual({
        status: 'rejected',
        reason: 'underage',
      });
    }
  });

  it.each(['rejected', 'pending', 'not_started'] as const)(
    'passes a %s vendor status through untouched',
    (vendor) => {
      expect(gateVendorDecision(vendor, [{ step: 'ID', status: 'declined' }], adult)).toEqual({
        status: vendor,
      });
    },
  );

  it('approves when the vendor approved and every check passed', () => {
    expect(gateVendorDecision('approved', approvedChecks, adult)).toEqual({ status: 'approved' });
  });

  it('approves when the vendor reported no per-step checks at all', () => {
    expect(gateVendorDecision('approved', undefined, adult)).toEqual({ status: 'approved' });
  });

  it('requests resubmission when the vendor approved but a check did not pass', () => {
    expect(
      gateVendorDecision(
        'approved',
        [
          { step: 'ID_VERIFICATION', status: 'approved' },
          { step: 'LIVENESS', status: 'declined' },
        ],
        adult,
      ),
    ).toEqual({
      status: 'resubmission_requested',
      reason:
        'Vendor reported approved but "LIVENESS" has not reached a successful state (status: declined)',
    });
  });

  it('requests resubmission when the vendor approved with an empty check list', () => {
    expect(gateVendorDecision('approved', [], adult)).toEqual({
      status: 'resubmission_requested',
      reason:
        'Vendor reported approved but "workflow" has not reached a successful state (status: unknown)',
    });
  });

  it('requests resubmission when approved with an unreadable date of birth', () => {
    expect(
      gateVendorDecision('approved', approvedChecks, { underage: false, unreadable: true }),
    ).toEqual({
      status: 'resubmission_requested',
      reason: 'date_of_birth_unreadable',
    });
  });

  it('reports the failed check before the unreadable date of birth', () => {
    const gated = gateVendorDecision('approved', [{ step: 'AML', status: 'in_review' }], {
      underage: false,
      unreadable: true,
    });
    expect(gated.reason).toContain('"AML"');
  });

  it('never returns approved unless every check is approved and the date is readable', () => {
    const checkStatus = fc.constantFrom(
      'not_started',
      'in_progress',
      'in_review',
      'approved',
      'declined',
      'expired',
      'unknown',
    );
    const checks = fc.option(
      fc.array(fc.record({ step: fc.string(), status: checkStatus }), { maxLength: 5 }),
      { nil: undefined },
    );
    fc.assert(
      fc.property(
        fc.constantFrom('approved', 'rejected', 'pending', 'not_started'),
        checks,
        fc.boolean(),
        fc.boolean(),
        (vendor, list, underage, unreadable) => {
          const { status } = gateVendorDecision(vendor, list, { underage, unreadable });
          if (status === 'approved') {
            expect(vendor).toBe('approved');
            expect(underage).toBe(false);
            expect(unreadable).toBe(false);
            expect((list ?? []).every((check) => check.status === 'approved')).toBe(true);
            expect(list === undefined || list.length > 0).toBe(true);
          }
        },
      ),
    );
  });
});

describe('isDecided', () => {
  it.each([
    ['approved', true],
    ['verified', true],
    ['rejected', true],
    ['manually_overridden', true],
    ['not_started', false],
    ['pending', false],
    ['resubmission_requested', false],
  ] as const)('%s -> %s', (status, expected) => {
    expect(isDecided(status)).toBe(expected);
  });

  it('classifies every known status', () => {
    const decided = new Set<KycStatus>(['approved', 'verified', 'rejected', 'manually_overridden']);
    for (const status of KYC_STATUSES) {
      expect(isDecided(status)).toBe(decided.has(status));
    }
  });
});

describe('resolveManualStatus', () => {
  it('turns a manual approval into manually_overridden', () => {
    expect(resolveManualStatus('approved')).toBe('manually_overridden');
  });

  it('leaves every other override status unchanged', () => {
    for (const status of [
      'rejected',
      'resubmission_requested',
      'pending',
      'not_started',
    ] as const) {
      expect(() => resolveManualStatus(status as never)).not.toThrow();
    }
    expect(resolveManualStatus('rejected')).toBe('rejected');
  });

  it('always yields a decided status for an approval', () => {
    expect(isDecided(resolveManualStatus('approved'))).toBe(true);
  });
});

describe('toPlayerSummaryView', () => {
  const verification = (
    tier: 'basic' | 'advanced',
    index: number,
  ): NonNullable<PlayerKycView['basic']['current']> => ({
    id: `00000000-0000-4000-8000-00000000000${index}`,
    userId: '00000000-0000-4000-8000-0000000000aa',
    provider: 'vendor-x',
    referenceId: `ref-${index}`,
    tier,
    status: 'approved',
    documentTypes: ['passport'],
    decisionReason: 'free text with personal data',
    triggeredBy: 'exemption',
    riskSignals: {
      vpnOrTorDetected: true,
      dataCenterIpDetected: true,
      duplicateDeviceDetected: true,
      highRiskCountryDetected: true,
      deviceFingerprints: ['fp-1'],
    },
    checks: [{ step: 'ID', status: 'approved' }],
    submittedAt: '2026-01-01T00:00:00.000Z',
    decidedAt: '2026-01-02T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  });

  const summaryKeys = [
    'createdAt',
    'decidedAt',
    'documentTypes',
    'exempt',
    'status',
    'submittedAt',
    'tier',
    'updatedAt',
  ];

  const view: PlayerKycView = {
    basic: {
      current: verification('basic', 1),
      history: [verification('basic', 2), verification('basic', 3)],
    },
    advanced: { current: null, history: [] },
  };

  it('exposes exactly the player-safe key set on every verification', () => {
    const summary = toPlayerSummaryView(view);
    const rows = [summary.basic.current, ...summary.basic.history];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(Object.keys(row ?? {}).sort()).toEqual(summaryKeys);
    }
  });

  it('exposes exactly basic and advanced, each with current and history', () => {
    const summary = toPlayerSummaryView(view);
    expect(Object.keys(summary).sort()).toEqual(['advanced', 'basic']);
    expect(Object.keys(summary.basic).sort()).toEqual(['current', 'history']);
    expect(Object.keys(summary.advanced).sort()).toEqual(['current', 'history']);
  });

  it('leaks none of the internal values anywhere in the serialized output', () => {
    const serialized = JSON.stringify(toPlayerSummaryView(view));
    for (const secret of [
      'vendor-x',
      'ref-1',
      'free text',
      'fp-1',
      'riskSignals',
      'checks',
      '0000000000aa',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('derives exempt from triggeredBy exemption only', () => {
    const exempt = toPlayerSummaryView(view).basic.current;
    const other: PlayerKycView = {
      ...view,
      basic: { current: { ...verification('basic', 1), triggeredBy: 'submission' }, history: [] },
    };
    expect(exempt?.exempt).toBe(true);
    expect(toPlayerSummaryView(other).basic.current?.exempt).toBe(false);
  });

  it('keeps null current and preserves history order', () => {
    const summary = toPlayerSummaryView(view);
    expect(summary.advanced.current).toBeNull();
    expect(summary.basic.history.map((row) => row.updatedAt)).toEqual([
      '2026-01-02T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
    ]);
  });
});
