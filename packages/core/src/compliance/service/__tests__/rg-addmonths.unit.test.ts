import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addMonths } from '../rg.service.js';

const utc = (iso: string) => new Date(iso);

describe('addMonths', () => {
  it.each([
    ['2026-01-15T10:00:00.000Z', 1, '2026-02-15T10:00:00.000Z'],
    ['2026-01-31T10:00:00.000Z', 1, '2026-02-28T10:00:00.000Z'],
    ['2028-01-31T10:00:00.000Z', 1, '2028-02-29T10:00:00.000Z'],
    ['2028-02-29T10:00:00.000Z', 12, '2029-02-28T10:00:00.000Z'],
    ['2028-02-29T10:00:00.000Z', 48, '2032-02-29T10:00:00.000Z'],
    ['2026-03-31T10:00:00.000Z', 1, '2026-04-30T10:00:00.000Z'],
    ['2026-05-31T10:00:00.000Z', 1, '2026-06-30T10:00:00.000Z'],
    ['2026-10-31T10:00:00.000Z', 4, '2027-02-28T10:00:00.000Z'],
    ['2026-11-30T10:00:00.000Z', 3, '2027-02-28T10:00:00.000Z'],
    ['2026-12-31T10:00:00.000Z', 2, '2027-02-28T10:00:00.000Z'],
    ['2026-06-10T10:00:00.000Z', 0, '2026-06-10T10:00:00.000Z'],
  ])('%s + %d months = %s', (from, months, expected) => {
    expect(addMonths(utc(from), months).toISOString()).toBe(expected);
  });

  it.each([
    ['2026-01-31T00:00:00.000Z', 1, '2026-02-28T00:00:00.000Z'],
    ['2026-01-31T23:59:59.999Z', 1, '2026-02-28T23:59:59.999Z'],
    ['2026-03-01T00:00:00.000Z', 1, '2026-04-01T00:00:00.000Z'],
    ['2026-03-31T23:30:00.000Z', 1, '2026-04-30T23:30:00.000Z'],
    ['2026-05-01T00:30:00.000Z', 1, '2026-06-01T00:30:00.000Z'],
    ['2026-05-31T00:30:00.000Z', 1, '2026-06-30T00:30:00.000Z'],
  ])('near UTC midnight %s + %d months = %s regardless of process TZ', (from, months, expected) => {
    expect(addMonths(utc(from), months).toISOString()).toBe(expected);
  });

  it('does not mutate its input', () => {
    const from = utc('2026-01-31T10:00:00.000Z');
    addMonths(from, 1);
    expect(from.toISOString()).toBe('2026-01-31T10:00:00.000Z');
  });

  it('keeps the UTC day at or below the original and lands in the target UTC month', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('2000-01-01T00:00:00.000Z'),
          max: new Date('2100-01-01T00:00:00.000Z'),
          noInvalidDate: true,
        }),
        fc.integer({ min: 0, max: 120 }),
        (from, months) => {
          const result = addMonths(from, months);
          const totalMonths = from.getUTCFullYear() * 12 + from.getUTCMonth() + months;
          const resultMonths = result.getUTCFullYear() * 12 + result.getUTCMonth();
          return resultMonths === totalMonths && result.getUTCDate() <= from.getUTCDate();
        },
      ),
    );
  });

  it('preserves the UTC time of day', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('2000-01-01T00:00:00.000Z'),
          max: new Date('2100-01-01T00:00:00.000Z'),
          noInvalidDate: true,
        }),
        fc.integer({ min: 0, max: 120 }),
        (from, months) => {
          const result = addMonths(from, months);
          const ms = (d: Date) => d.getTime() % 86_400_000;
          return ms(result) === ms(from);
        },
      ),
    );
  });
});
