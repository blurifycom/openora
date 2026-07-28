import { describe, it, expect } from 'vitest';
import { KYC_STATUSES, KycStatusSchema, normalizeKycStatus } from '../player.js';

describe('normalizeKycStatus', () => {
  it('normalizes the deprecated verified value to approved', () => {
    expect(normalizeKycStatus('verified')).toBe('approved');
  });

  it('passes approved through unchanged', () => {
    expect(normalizeKycStatus('approved')).toBe('approved');
  });

  it('leaves every other status untouched', () => {
    for (const status of [
      'not_started',
      'pending',
      'rejected',
      'resubmission_requested',
      'manually_overridden',
    ] as const) {
      expect(normalizeKycStatus(status)).toBe(status);
    }
  });
});

describe('KYC_STATUSES', () => {
  it('accepts both the canonical approved value and the deprecated verified alias', () => {
    expect(KYC_STATUSES).toContain('approved');
    expect(KYC_STATUSES).toContain('verified');
    expect(KycStatusSchema.safeParse('approved').success).toBe(true);
    expect(KycStatusSchema.safeParse('verified').success).toBe(true);
  });
});
