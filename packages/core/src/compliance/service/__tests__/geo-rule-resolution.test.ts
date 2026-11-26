import { describe, expect, it } from 'vitest';
import {
  effectiveAccessOf,
  hasCountryRuleChanges,
  hasExpectedVersion,
  moneyEqualsOrBothNull,
  needsConfirmation,
} from '../compliance.service.js';

const MIRROR = 'https://mirror.example.com';

const settings = (
  overrides: Partial<{
    blacklisted: boolean;
    redirectIp: boolean;
    mirrorUrl: string | null;
    kycRequired: boolean;
  }>,
) => ({
  blacklisted: false,
  redirectIp: false,
  mirrorUrl: null,
  kycRequired: true,
  ...overrides,
});

const row = (
  overrides: Partial<{
    action: 'block' | 'allow';
    redirectIp: boolean;
    mirrorUrl: string | null;
    kycRequired: boolean;
  }> = {},
) => ({
  id: '00000000-0000-4000-8000-000000000001',
  countryCode: 'DE',
  action: 'allow' as const,
  redirectIp: false,
  mirrorUrl: null,
  kycRequired: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: null,
  updatedBy: null,
  ...overrides,
});

describe('effective country access', () => {
  it('a deployment-blocked country is blocked regardless of the rule', () => {
    expect(effectiveAccessOf(settings({}), true)).toBe('blocked');
    expect(
      effectiveAccessOf(settings({ blacklisted: true, redirectIp: true, mirrorUrl: MIRROR }), true),
    ).toBe('blocked');
    expect(effectiveAccessOf(settings({ redirectIp: true, mirrorUrl: MIRROR }), true)).toBe(
      'blocked',
    );
  });

  it('a blacklisted country without redirect is blocked', () => {
    expect(effectiveAccessOf(settings({ blacklisted: true }), false)).toBe('blocked');
    expect(effectiveAccessOf(settings({ blacklisted: true, mirrorUrl: MIRROR }), false)).toBe(
      'blocked',
    );
  });

  it('a blacklisted country with redirect and a mirror target is redirected', () => {
    expect(
      effectiveAccessOf(
        settings({ blacklisted: true, redirectIp: true, mirrorUrl: MIRROR }),
        false,
      ),
    ).toBe('redirected');
  });

  it('a blacklisted country with redirect and an empty mirror target is blocked', () => {
    expect(
      effectiveAccessOf(settings({ blacklisted: true, redirectIp: true, mirrorUrl: '' }), false),
    ).toBe('blocked');
  });

  it('a blacklisted country with redirect and a null mirror target is blocked', () => {
    expect(
      effectiveAccessOf(settings({ blacklisted: true, redirectIp: true, mirrorUrl: null }), false),
    ).toBe('blocked');
  });

  it('a country that is not blacklisted with a mirror target is redirected', () => {
    expect(effectiveAccessOf(settings({ redirectIp: true, mirrorUrl: MIRROR }), false)).toBe(
      'redirected',
    );
  });

  it('a country that is not blacklisted and has no redirect is open', () => {
    expect(effectiveAccessOf(settings({}), false)).toBe('open');
    expect(effectiveAccessOf(settings({ mirrorUrl: MIRROR }), false)).toBe('open');
    expect(effectiveAccessOf(settings({ redirectIp: true, mirrorUrl: '' }), false)).toBe('open');
  });
});

describe('country rule change detection', () => {
  it('a rule saved with identical values has no changes', () => {
    const before = row({
      action: 'block',
      redirectIp: true,
      mirrorUrl: MIRROR,
      kycRequired: false,
    });
    const next = settings({
      blacklisted: true,
      redirectIp: true,
      mirrorUrl: MIRROR,
      kycRequired: false,
    });
    expect(hasCountryRuleChanges(before, next)).toBe(false);
    expect(needsConfirmation(before, next)).toBe(false);
  });

  it('a changed access field is a change that needs confirmation', () => {
    const before = row({ action: 'allow' });
    const next = settings({ blacklisted: true });
    expect(hasCountryRuleChanges(before, next)).toBe(true);
    expect(needsConfirmation(before, next)).toBe(true);
    expect(needsConfirmation(row({ action: 'block' }), settings({ blacklisted: false }))).toBe(
      true,
    );
  });

  it('dropping KYC needs confirmation and turning it on does not', () => {
    expect(needsConfirmation(row({ kycRequired: true }), settings({ kycRequired: false }))).toBe(
      true,
    );
    expect(needsConfirmation(row({ kycRequired: false }), settings({ kycRequired: true }))).toBe(
      false,
    );
  });

  it('opening a denied country needs confirmation and closing a mirror does not', () => {
    const blockedBefore = row({ action: 'block' });
    expect(
      needsConfirmation(
        blockedBefore,
        settings({ blacklisted: true, redirectIp: true, mirrorUrl: MIRROR }),
      ),
    ).toBe(true);
    const redirectedBefore = row({ action: 'block', redirectIp: true, mirrorUrl: MIRROR });
    expect(
      needsConfirmation(redirectedBefore, settings({ blacklisted: true, redirectIp: false })),
    ).toBe(false);
  });

  it('a money field compared as equal strings or both null is not a change', () => {
    expect(moneyEqualsOrBothNull(null, null)).toBe(true);
    expect(moneyEqualsOrBothNull('100', '100')).toBe(true);
    expect(moneyEqualsOrBothNull('100.00', '100')).toBe(true);
    expect(moneyEqualsOrBothNull(null, '0')).toBe(false);
    expect(moneyEqualsOrBothNull('0', null)).toBe(false);
    expect(moneyEqualsOrBothNull('100', '100.01')).toBe(false);
  });

  it('an expected version equal to the stored update time is not a conflict', () => {
    const updatedAt = new Date('2026-02-01T10:00:00.000Z');
    expect(hasExpectedVersion(updatedAt, updatedAt.toISOString())).toBe(true);
    expect(hasExpectedVersion(null, null)).toBe(true);
  });

  it('an expected version that differs from the stored update time is a conflict', () => {
    const updatedAt = new Date('2026-02-01T10:00:00.000Z');
    expect(hasExpectedVersion(updatedAt, '2026-02-01T10:00:00.001Z')).toBe(false);
    expect(hasExpectedVersion(null, updatedAt.toISOString())).toBe(false);
  });

  it.todo('an absent expected version never conflicts');
});
