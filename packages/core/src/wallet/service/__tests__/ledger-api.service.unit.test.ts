import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { fingerprint, parseArgs, reverseFingerprint } from '../ledger-api.service.js';

describe('fingerprint', () => {
  it('is deterministic and hex sha256', () => {
    fc.assert(
      fc.property(fc.array(fc.jsonValue()), (parts) => {
        expect(fingerprint(parts)).toBe(fingerprint(parts));
        expect(fingerprint(parts)).toMatch(/^[0-9a-f]{64}$/);
      }),
    );
  });

  it('separates different parts', () => {
    expect(fingerprint(['a', 'b'])).not.toBe(fingerprint(['ab']));
    expect(fingerprint(['a', 'b'])).not.toBe(fingerprint(['b', 'a']));
  });

  it('does not collide across a delimiter boundary', () => {
    expect(fingerprint(['a:b', 'c'])).not.toBe(fingerprint(['a', 'b:c']));
  });
});

describe('reverseFingerprint', () => {
  const key = {
    providerName: 'p',
    userId: 'A1B2C3D4-0000-4000-8000-ABCDEFABCDEF',
    gameId: 'F1E2D3C4-0000-4000-8000-ABCDEFABCDEF',
    targetRefId: 'Ref-1',
  };

  it('is the same for upper and lower case uuids', () => {
    expect(reverseFingerprint(key)).toBe(
      reverseFingerprint({
        ...key,
        userId: key.userId.toLowerCase(),
        gameId: key.gameId.toLowerCase(),
      }),
    );
  });

  it('keeps the provider name and target ref case sensitive', () => {
    expect(reverseFingerprint(key)).not.toBe(reverseFingerprint({ ...key, providerName: 'P' }));
    expect(reverseFingerprint(key)).not.toBe(reverseFingerprint({ ...key, targetRefId: 'ref-1' }));
  });

  it.each(['providerName', 'userId', 'gameId', 'targetRefId'] as const)(
    'changes when %s changes',
    (field) => {
      expect(reverseFingerprint(key)).not.toBe(
        reverseFingerprint({ ...key, [field]: `${key[field]}x` }),
      );
    },
  );

  it('is not equal to a fingerprint of the same parts without the reverse tag', () => {
    expect(reverseFingerprint(key)).not.toBe(
      fingerprint([
        key.providerName,
        key.userId.toLowerCase(),
        key.gameId.toLowerCase(),
        key.targetRefId,
      ]),
    );
  });
});

describe('parseArgs', () => {
  const schema = z.object({ amount: z.string().regex(/^\d+$/), name: z.string() });

  it('returns the parsed data', () => {
    expect(parseArgs(schema, { amount: '1', name: 'x' })).toEqual({ amount: '1', name: 'x' });
  });

  it('refuses with invalid_amount when only the amount is wrong', () => {
    expect(() => parseArgs(schema, { amount: 'x', name: 'x' })).toThrow(
      expect.objectContaining({ name: 'LedgerRefusal', reason: 'invalid_amount' }),
    );
  });

  it('rethrows the zod error when another field is wrong', () => {
    expect(() => parseArgs(schema, { amount: '1', name: 1 })).toThrow(z.ZodError);
  });

  it('rethrows the zod error when the amount and another field are wrong', () => {
    expect(() => parseArgs(schema, { amount: 'x', name: 1 })).toThrow(z.ZodError);
  });

  it('rethrows the zod error for a non-object input', () => {
    expect(() => parseArgs(schema, null)).toThrow(z.ZodError);
  });

  it('refuses with invalid_amount when the amount is missing', () => {
    expect(() => parseArgs(schema, { name: 'x' })).toThrow(
      expect.objectContaining({ reason: 'invalid_amount' }),
    );
  });
});
