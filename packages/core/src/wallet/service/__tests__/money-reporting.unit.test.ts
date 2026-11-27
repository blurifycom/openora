import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { dayAfter, toBucketKey } from '../money-reporting.service.js';

describe('toBucketKey', () => {
  it.each([
    ['a UTC midnight date', new Date('2026-03-29T00:00:00.000Z'), '2026-03-29'],
    ['the last millisecond of a day', new Date('2026-03-29T23:59:59.999Z'), '2026-03-29'],
    ['a pg timestamp string with offset', '2026-03-29 01:30:00+02', '2026-03-28'],
    ['an ISO string', '2026-12-31T23:00:00.000Z', '2026-12-31'],
    ['a leap day', '2028-02-29T12:00:00Z', '2028-02-29'],
  ])('keys %s by its UTC day', (_name, bucket, expected) => {
    expect(toBucketKey(bucket)).toBe(expected);
  });

  it('throws on a bucket that is not a date instead of keying it', () => {
    expect(() => toBucketKey('not a date')).toThrow(RangeError);
  });
});

describe('dayAfter', () => {
  it.each([
    ['an ordinary day', '2026-06-10', '2026-06-11T00:00:00.000Z'],
    ['the EU spring DST change', '2026-03-29', '2026-03-30T00:00:00.000Z'],
    ['the EU autumn DST change', '2026-10-25', '2026-10-26T00:00:00.000Z'],
    ['the US spring DST change', '2026-03-08', '2026-03-09T00:00:00.000Z'],
    ['a month end', '2026-04-30', '2026-05-01T00:00:00.000Z'],
    ['a leap February', '2028-02-28', '2028-02-29T00:00:00.000Z'],
    ['a leap day', '2028-02-29', '2028-03-01T00:00:00.000Z'],
    ['a non-leap February', '2026-02-28', '2026-03-01T00:00:00.000Z'],
    ['a year end', '2026-12-31', '2027-01-01T00:00:00.000Z'],
  ])('starts the day after %s at UTC midnight', (_name, isoDay, expected) => {
    expect(dayAfter(isoDay).toISOString()).toBe(expected);
  });

  it('is the next UTC calendar day for any day', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('1970-01-01'), max: new Date('2100-12-31'), noInvalidDate: true }),
        (date) => {
          const day = date.toISOString().slice(0, 10);
          const next = new Date(`${day}T00:00:00.000Z`);
          next.setUTCDate(next.getUTCDate() + 1);
          expect(dayAfter(day).getTime()).toBe(next.getTime());
        },
      ),
    );
  });
});
