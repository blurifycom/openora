import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { hashWithdrawalPin } from '../withdrawal-pin-hash.service.js';
import { pinMatches } from '../withdrawal-pin.service.js';

const SECRET = 'a'.repeat(32);

describe('hashWithdrawalPin', () => {
  it.each([
    ['1234', SECRET, 'b53b6c510f807f571da06f5d91fa984d8be303a44753f695f37ed0bf5fc8a2a0'],
    ['1234', 'b'.repeat(32), 'af89fa9734d4659d06fb8b1c0cd456990edb4633df0a4b56ea72373c5d8bdadc'],
  ])('hashes pin %s under secret %s to the golden digest', (pin, secret, expected) => {
    expect(hashWithdrawalPin(pin, secret)).toBe(expected);
  });

  it('yields a 64 char lowercase hex digest', () => {
    expect(hashWithdrawalPin('0000', SECRET)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the hash when the secret changes', () => {
    expect(hashWithdrawalPin('1234', SECRET)).not.toBe(hashWithdrawalPin('1234', `${SECRET}x`));
  });

  it('is not the plain sha256 of the pin', () => {
    expect(hashWithdrawalPin('1234', SECRET)).not.toBe(
      '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4',
    );
  });

  it('gives every one of the 10000 pins its own hash', () => {
    const hashes = new Set<string>();
    for (let n = 0; n < 10_000; n++) {
      hashes.add(hashWithdrawalPin(String(n).padStart(4, '0'), SECRET));
    }
    expect(hashes.size).toBe(10_000);
  });

  it('is deterministic and differs for any two different pins', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(hashWithdrawalPin(a, SECRET)).toBe(hashWithdrawalPin(a, SECRET));
        expect(a === b).toBe(hashWithdrawalPin(a, SECRET) === hashWithdrawalPin(b, SECRET));
      }),
    );
  });
});

describe('pinMatches', () => {
  const stored = hashWithdrawalPin('1234', SECRET);

  it('accepts the identical hash', () => {
    expect(pinMatches(hashWithdrawalPin('1234', SECRET), stored)).toBe(true);
  });

  it('rejects a hash of a pin one digit off', () => {
    expect(pinMatches(hashWithdrawalPin('1235', SECRET), stored)).toBe(false);
  });

  it('rejects a hash made under another secret', () => {
    expect(pinMatches(hashWithdrawalPin('1234', 'b'.repeat(32)), stored)).toBe(false);
  });

  it.each([
    ['empty candidate', ''],
    ['truncated candidate', stored.slice(0, 63)],
    ['extended candidate', `${stored}0`],
    ['raw pin', '1234'],
  ])('returns false without throwing for a %s', (_name, candidate) => {
    expect(() => pinMatches(candidate, stored)).not.toThrow();
    expect(pinMatches(candidate, stored)).toBe(false);
  });

  it('returns false against an empty stored hash', () => {
    expect(pinMatches(stored, '')).toBe(false);
  });

  it('matches only equal strings', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(pinMatches(a, b)).toBe(a === b);
      }),
    );
  });
});
