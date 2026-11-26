import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeHash, endOfDayUtc, startOfDayUtc } from '../audit.service.js';

type HashInput = Parameters<typeof computeHash>[0];

const base: HashInput = {
  id: '00000000-0000-4000-8000-000000000001',
  actorId: 'actor-1',
  actorType: 'admin',
  action: 'wallet.adjust',
  resourceType: 'wallet',
  resourceId: 'wallet-1',
  before: { balance: '10.00', meta: { a: 1, b: 2 } },
  after: { balance: '5.00', meta: { a: 1, b: 3 } },
  result: 'success',
  seq: 7,
  prevHash: 'abc123',
  createdAt: '2026-01-02T03:04:05.678Z',
};

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const literalInput = (override: Record<string, unknown>) =>
  JSON.stringify({
    id: base.id,
    actorId: base.actorId,
    actorType: base.actorType,
    action: base.action,
    resourceType: base.resourceType,
    resourceId: base.resourceId,
    before: { balance: '10.00', meta: { a: 1, b: 2 } },
    after: { balance: '5.00', meta: { a: 1, b: 3 } },
    result: base.result,
    seq: base.seq,
    createdAt: base.createdAt,
    prevHash: base.prevHash,
    ...override,
  });

describe('canonical hash input', () => {
  it('the same before and after with different key order hash the same', () => {
    const reordered: HashInput = {
      ...base,
      before: { meta: { b: 2, a: 1 }, balance: '10.00' },
      after: { meta: { b: 3, a: 1 }, balance: '5.00' },
    };
    expect(computeHash(reordered)).toBe(computeHash(base));
    expect(computeHash(base)).toBe(computeHash({ ...base }));
  });

  it('nested objects are key-sorted but array order is kept', () => {
    const nested: HashInput = { ...base, after: { list: [{ z: 1, a: 2 }, 3], k: { y: 1, x: 2 } } };
    const nestedReordered: HashInput = {
      ...base,
      after: { k: { x: 2, y: 1 }, list: [{ a: 2, z: 1 }, 3] },
    };
    const arrayReordered: HashInput = {
      ...base,
      after: { k: { x: 2, y: 1 }, list: [3, { a: 2, z: 1 }] },
    };
    expect(computeHash(nestedReordered)).toBe(computeHash(nested));
    expect(computeHash(arrayReordered)).not.toBe(computeHash(nested));
  });

  it('a missing before or after hashes as null', () => {
    const withNull: HashInput = { ...base, before: null, after: null };
    expect(computeHash(withNull)).toBe(sha256(literalInput({ before: null, after: null })));
    expect(computeHash(withNull)).not.toBe(computeHash({ ...base, before: {}, after: {} }));
  });

  it('a missing previous hash hashes as an empty string', () => {
    const withNull: HashInput = { ...base, prevHash: null };
    expect(computeHash(withNull)).toBe(sha256(literalInput({ prevHash: '' })));
    expect(computeHash(withNull)).toBe(computeHash({ ...base, prevHash: '' }));
    expect(computeHash(withNull)).not.toBe(computeHash(base));
  });

  it.each<[string, Partial<HashInput>]>([
    ['id', { id: '00000000-0000-4000-8000-000000000002' }],
    ['actorId', { actorId: 'actor-2' }],
    ['actorType', { actorType: 'system' }],
    ['action', { action: 'wallet.adjust2' }],
    ['resourceType', { resourceType: 'player' }],
    ['resourceId', { resourceId: 'wallet-2' }],
    ['before', { before: { balance: '10.01', meta: { a: 1, b: 2 } } }],
    ['after', { after: { balance: '5.01', meta: { a: 1, b: 3 } } }],
    ['result', { result: 'failure' }],
    ['seq', { seq: 8 }],
    ['prevHash', { prevHash: 'abc124' }],
    ['createdAt', { createdAt: '2026-01-02T03:04:05.679Z' }],
  ])('changing %s changes the hash', (_field, change) => {
    expect(computeHash({ ...base, ...change })).not.toBe(computeHash(base));
  });

  it('a nested before or after change that only moves a value between fields changes the hash', () => {
    const swapped: HashInput = { ...base, before: base.after, after: base.before };
    expect(computeHash(swapped)).not.toBe(computeHash(base));
  });

  it('the hash is a 64 character lowercase hex sha256', () => {
    expect(computeHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('day bounds', () => {
  it('start of day is midnight UTC of the given date', () => {
    expect(startOfDayUtc('2026-03-15').toISOString()).toBe('2026-03-15T00:00:00.000Z');
  });

  it('end of day is 23:59:59.999 UTC of the given date', () => {
    expect(endOfDayUtc('2026-03-15').toISOString()).toBe('2026-03-15T23:59:59.999Z');
  });

  it('a date with a time part and offset resolves to the UTC day', () => {
    const lateInUtcPlus2 = '2026-03-15T01:30:00+02:00';
    expect(startOfDayUtc(lateInUtcPlus2).toISOString()).toBe('2026-03-14T00:00:00.000Z');
    expect(endOfDayUtc(lateInUtcPlus2).toISOString()).toBe('2026-03-14T23:59:59.999Z');
    expect(startOfDayUtc('2026-03-15T23:59:59.999Z').toISOString()).toBe(
      '2026-03-15T00:00:00.000Z',
    );
  });

  it('the bounds of the last day of a month and a leap day are correct', () => {
    expect(endOfDayUtc('2026-01-31').toISOString()).toBe('2026-01-31T23:59:59.999Z');
    expect(startOfDayUtc('2026-02-28').toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(startOfDayUtc('2024-02-29').toISOString()).toBe('2024-02-29T00:00:00.000Z');
    expect(endOfDayUtc('2024-02-29').toISOString()).toBe('2024-02-29T23:59:59.999Z');
    expect(endOfDayUtc('2025-12-31').toISOString()).toBe('2025-12-31T23:59:59.999Z');
  });
});
