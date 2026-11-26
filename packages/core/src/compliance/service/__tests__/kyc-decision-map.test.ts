import type { KycCheckResult, KycRiskSignals, KycVendorStatus } from '@openora/core/contracts';
import { describe, expect, it } from 'vitest';
import {
  gateVendorDecision,
  isDecided,
  mapVendorStatus,
  resolveManualStatus,
  warrantsHighRiskTag,
} from '../kyc.service.js';

const adult = { underage: false, unreadable: false };
const signals = (overrides: Partial<KycRiskSignals>): KycRiskSignals => ({
  vpnOrTorDetected: false,
  dataCenterIpDetected: false,
  duplicateDeviceDetected: false,
  highRiskCountryDetected: false,
  deviceFingerprints: [],
  ...overrides,
});
const approvedCheck: KycCheckResult = { step: 'ID_VERIFICATION', status: 'approved' };

describe('vendor status mapping', () => {
  it('maps approved, rejected, pending and not started to the matching KYC status', () => {
    const cases: ReadonlyArray<readonly [KycVendorStatus, string]> = [
      ['approved', 'approved'],
      ['rejected', 'rejected'],
      ['pending', 'pending'],
      ['not_started', 'not_started'],
    ];
    for (const [vendor, expected] of cases) {
      expect(mapVendorStatus(vendor)).toBe(expected);
    }
  });
});

describe('vendor decision gate', () => {
  it.each<KycVendorStatus>(['approved', 'rejected', 'pending', 'not_started'])(
    'an underage date of birth declines with the underage reason regardless of vendor status (%s)',
    (vendor) => {
      expect(
        gateVendorDecision(vendor, [approvedCheck], { underage: true, unreadable: false }),
      ).toEqual({ status: 'rejected', reason: 'underage' });
    },
  );

  it('an approved vendor status with all checks approved stays approved', () => {
    expect(
      gateVendorDecision(
        'approved',
        [approvedCheck, { step: 'LIVENESS', status: 'approved' }],
        adult,
      ),
    ).toEqual({ status: 'approved' });
  });

  it.each<KycCheckResult['status']>([
    'declined',
    'in_review',
    'in_progress',
    'not_started',
    'expired',
    'unknown',
  ])(
    'an approved vendor status with a failed or unknown check requests resubmission with the check named (%s)',
    (status) => {
      const result = gateVendorDecision(
        'approved',
        [approvedCheck, { step: 'LIVENESS', status }],
        adult,
      );
      expect(result.status).toBe('resubmission_requested');
      expect(result.reason).toContain('"LIVENESS"');
      expect(result.reason).toContain(`status: ${status}`);
    },
  );

  it('an approved vendor status with an empty check list requests resubmission', () => {
    const result = gateVendorDecision('approved', [], adult);
    expect(result.status).toBe('resubmission_requested');
    expect(result.reason).toContain('"workflow"');
  });

  it('an approved vendor status without a check list is approved', () => {
    expect(gateVendorDecision('approved', undefined, adult)).toEqual({ status: 'approved' });
  });

  it('an approved vendor status with an unreadable date of birth requests resubmission', () => {
    expect(
      gateVendorDecision('approved', [approvedCheck], { underage: false, unreadable: true }),
    ).toEqual({ status: 'resubmission_requested', reason: 'date_of_birth_unreadable' });
  });

  it('a rejected vendor status stays rejected even when all checks are approved', () => {
    expect(gateVendorDecision('rejected', [approvedCheck], adult)).toEqual({
      status: 'rejected',
    });
  });

  it.each<KycVendorStatus>(['pending', 'not_started'])(
    'a pending vendor status passes through unchanged (%s)',
    (vendor) => {
      expect(gateVendorDecision(vendor, [], { underage: false, unreadable: true })).toEqual({
        status: vendor,
      });
    },
  );
});

describe('decided statuses and manual override', () => {
  it.each(['approved', 'verified', 'rejected', 'manually_overridden'] as const)(
    'approved, rejected and manually overridden count as decided (%s)',
    (status) => {
      expect(isDecided(status)).toBe(true);
    },
  );

  it.each(['pending', 'not_started', 'resubmission_requested'] as const)(
    'pending, not started and resubmission requested count as undecided (%s)',
    (status) => {
      expect(isDecided(status)).toBe(false);
    },
  );

  it('a manual approved override resolves to manually overridden', () => {
    expect(resolveManualStatus('approved')).toBe('manually_overridden');
  });

  it('a manual rejected override resolves to rejected', () => {
    expect(resolveManualStatus('rejected')).toBe('rejected');
  });

  it('duplicate device or high-risk country signals warrant the high-risk tag', () => {
    expect(warrantsHighRiskTag(signals({ duplicateDeviceDetected: true }))).toBe(true);
    expect(warrantsHighRiskTag(signals({ highRiskCountryDetected: true }))).toBe(true);
    expect(
      warrantsHighRiskTag(
        signals({ duplicateDeviceDetected: true, highRiskCountryDetected: true }),
      ),
    ).toBe(true);
  });

  it('no risk signal does not warrant the high-risk tag', () => {
    expect(warrantsHighRiskTag(signals({}))).toBe(false);
    expect(
      warrantsHighRiskTag(signals({ vpnOrTorDetected: true, dataCenterIpDetected: true })),
    ).toBe(false);
  });
});
