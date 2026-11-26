import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { KYC_STATUSES } from '@openora/core/contracts';
import { accountIneligibility } from '../account-manager.service.js';
import { toDateKey } from '../player.service.js';
import { kycStatusesMatching } from '../players-find.service.js';

describe('accountIneligibility', () => {
  it.each([
    ['player', true, 'not_eligible'],
    ['player', false, 'not_eligible'],
    ['admin', false, 'inactive'],
    ['support', false, 'inactive'],
    ['admin', true, null],
    ['support', true, null],
    ['Player', true, null],
  ] as const)('role %s active %s gives %j', (role, isActive, expected) => {
    expect(accountIneligibility({ role, isActive })).toBe(expected);
  });
});

describe('kycStatusesMatching', () => {
  it.each([
    [['approved'], ['approved', 'verified']],
    [['verified'], ['approved', 'verified']],
    [
      ['approved', 'verified'],
      ['approved', 'verified'],
    ],
    [['pending'], ['pending']],
    [
      ['pending', 'rejected'],
      ['pending', 'rejected'],
    ],
    [[], []],
    [
      ['pending', 'verified'],
      ['pending', 'approved', 'verified'],
    ],
  ] as const)('%j matches %j', (statuses, expected) => {
    expect(kycStatusesMatching(statuses)).toEqual(expected);
  });

  it('lists each status once and never hides approved behind verified', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...KYC_STATUSES)), (statuses) => {
        const matched = kycStatusesMatching(statuses);
        expect(new Set(matched).size).toBe(matched.length);
        expect(matched.includes('approved')).toBe(matched.includes('verified'));
        for (const status of statuses) {
          expect(matched).toContain(status);
        }
      }),
    );
  });

  it('does not mutate the input', () => {
    const statuses = ['verified'] as const;
    kycStatusesMatching(statuses);
    expect(statuses).toEqual(['verified']);
  });
});

describe('toDateKey', () => {
  it.each([
    ['2026-03-01T00:00:00.000Z', '2026-03-01'],
    ['2026-03-01T23:59:59.999Z', '2026-03-01'],
    ['2026-03-01T23:59:59.999-05:00', '2026-03-02'],
    ['2026-03-01T00:00:00.000+05:00', '2026-02-28'],
    ['2026-12-31T23:59:59.999Z', '2026-12-31'],
    ['2028-02-29T12:00:00.000Z', '2028-02-29'],
    ['2026-03-01T00:00:00.000-00:00', '2026-03-01'],
  ])('%s is the UTC day %s', (iso, expected) => {
    expect(toDateKey(new Date(iso))).toBe(expected);
  });

  it('is the UTC calendar day for any instant in the supported years', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('1970-01-01T00:00:00Z'), max: new Date('9999-12-31T23:59:59Z') }),
        (date) => {
          const key = toDateKey(date);
          expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(new Date(`${key}T00:00:00.000Z`).getTime()).toBeLessThanOrEqual(date.getTime());
          expect(new Date(`${key}T00:00:00.000Z`).getTime() + 86_400_000).toBeGreaterThan(
            date.getTime(),
          );
        },
      ),
    );
  });
});
