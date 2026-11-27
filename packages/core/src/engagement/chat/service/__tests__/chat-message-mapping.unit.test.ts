import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MONEY_SCALE } from '@openora/core/contracts';
import {
  canonicalizeMoneyString,
  sanitizeCommandMetadata,
} from '../chat-message-mapping.service.js';

describe('canonicalizeMoneyString', () => {
  it.each([
    ['1.5', '1.5'],
    ['10', '10'],
    ['0.000000000000000001', '0.000000000000000001'],
    ['1.000000000000000000', '1.000000000000000000'],
    ['1.0000000000000000001', '1'],
    ['1.5000000000000000009', '1.5'],
    ['1.1234567890123456789', '1.123456789012345678'],
    ['1.1000000000000000009999', '1.1'],
    ['0.0000000000000000001', '0'],
    ['007.50000000000000000000', '007.5'],
  ])('turns %s into %s', (input, expected) => {
    expect(canonicalizeMoneyString(input)).toBe(expected);
  });

  it.each([
    '-1.5',
    '-1.0000000000000000001',
    '1e-7',
    '1.5e3',
    '1.5E3',
    '.5',
    '5.',
    '1,5',
    ' 1.5',
    '1.5 ',
    '1.5.2',
    '+1.5',
    '0x10',
    'NaN',
    'Infinity',
    '',
    '١.٥',
    '1.５',
  ])('leaves the malformed amount %j alone for the contract to reject', (input) => {
    expect(canonicalizeMoneyString(input)).toBe(input);
  });

  it('never rounds up a fraction past the scale', () => {
    expect(canonicalizeMoneyString('0.9999999999999999999')).toBe('0.999999999999999999');
  });

  it('keeps the whole part untouched when the fraction is dropped', () => {
    expect(canonicalizeMoneyString('123456789012345678901234567890.0000000000000000009')).toBe(
      '123456789012345678901234567890',
    );
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^\d{1,6}\.\d{1,30}$/), (value) => {
        const once = canonicalizeMoneyString(value);
        expect(canonicalizeMoneyString(once)).toBe(once);
      }),
    );
  });

  it('never leaves more fraction digits than the money scale', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^\d{1,6}\.\d{1,40}$/), (value) => {
        const fraction = canonicalizeMoneyString(value).split('.')[1] ?? '';
        expect(fraction.length).toBeLessThanOrEqual(MONEY_SCALE);
      }),
    );
  });

  it('never ends a changed value with a trailing zero or a bare dot', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^\d{1,6}\.\d{19,40}$/), (value) => {
        const result = canonicalizeMoneyString(value);
        expect(result.endsWith('0') && result.includes('.')).toBe(false);
        expect(result.endsWith('.')).toBe(false);
      }),
    );
  });

  it('only ever shortens a value, never changes the digits it keeps', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^\d{1,6}\.\d{1,40}$/), (value) => {
        const result = canonicalizeMoneyString(value);
        const [whole = '', fraction = ''] = value.split('.');
        expect(result.startsWith(whole)).toBe(true);
        expect(fraction.startsWith(result.split('.')[1] ?? '')).toBe(true);
      }),
    );
  });
});

describe('sanitizeCommandMetadata', () => {
  it.each([null, undefined, 5, 'text', true])('returns the non-object %j as it is', (value) => {
    expect(sanitizeCommandMetadata(value)).toBe(value);
  });

  it('canonicalizes amount and perRecipient only', () => {
    expect(
      sanitizeCommandMetadata({
        amount: '1.0000000000000000001',
        perRecipient: '2.5000000000000000009',
        total: '3.0000000000000000001',
        note: '4.0000000000000000001',
      }),
    ).toEqual({
      amount: '1',
      perRecipient: '2.5',
      total: '3.0000000000000000001',
      note: '4.0000000000000000001',
    });
  });

  it.each([5, null, undefined, 1.5, { nested: '1.0000000000000000001' }])(
    'leaves a non-string amount %j untouched',
    (amount) => {
      expect(sanitizeCommandMetadata({ amount })).toEqual({ amount });
    },
  );

  it('keeps a negative or exponent amount for the contract to reject', () => {
    expect(
      sanitizeCommandMetadata({ amount: '-1.0000000000000000001', perRecipient: '1e-9' }),
    ).toEqual({
      amount: '-1.0000000000000000001',
      perRecipient: '1e-9',
    });
  });

  it('does not mutate its input', () => {
    const input = { amount: '1.0000000000000000001' };
    sanitizeCommandMetadata(input);
    expect(input).toEqual({ amount: '1.0000000000000000001' });
  });

  it('passes an array through as an object keyed by index', () => {
    expect(sanitizeCommandMetadata(['1.0000000000000000001'])).toEqual({
      0: '1.0000000000000000001',
    });
  });
});
