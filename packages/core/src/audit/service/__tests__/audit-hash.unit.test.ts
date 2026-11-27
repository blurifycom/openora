import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeHash, sortKeysDeep } from '../audit.service.js';

type Input = Parameters<typeof computeHash>[0];

const input = (over: Partial<Input> = {}): Input => ({
  id: '11111111-1111-4111-8111-111111111111',
  actorId: '22222222-2222-4222-8222-222222222222',
  actorType: 'admin',
  action: 'player.ban',
  resourceType: 'player',
  resourceId: '33333333-3333-4333-8333-333333333333',
  before: { status: 'active', limits: { daily: 10, weekly: 50 } },
  after: { status: 'banned', limits: { daily: 0, weekly: 0 } },
  result: 'success',
  seq: 7,
  prevHash: 'abc123',
  createdAt: '2026-03-01T10:20:30.000Z',
  ...over,
});

const GOLDEN_CANONICAL =
  '{"id":"11111111-1111-4111-8111-111111111111","actorId":"22222222-2222-4222-8222-222222222222",' +
  '"actorType":"admin","action":"player.ban","resourceType":"player",' +
  '"resourceId":"33333333-3333-4333-8333-333333333333",' +
  '"before":{"limits":{"daily":10,"weekly":50},"status":"active"},' +
  '"after":{"limits":{"daily":0,"weekly":0},"status":"banned"},' +
  '"result":"success","seq":7,"createdAt":"2026-03-01T10:20:30.000Z","prevHash":"abc123"}';

const jsonArb = fc.jsonValue();

const reverseKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(reverseKeys);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([k, v]) => [k, reverseKeys(v)] as const)
      .reverse(),
  );
};

const reverseRecord = (record: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(record)
      .map(([k, v]) => [k, reverseKeys(v)] as const)
      .reverse(),
  );

const payloadArb = fc.dictionary(fc.string(), fc.jsonValue());

describe('sortKeysDeep', () => {
  it('sorts keys at every depth', () => {
    expect(JSON.stringify(sortKeysDeep({ b: { z: 1, a: { y: 1, x: 2 } }, a: 1 }))).toBe(
      '{"a":1,"b":{"a":{"x":2,"y":1},"z":1}}',
    );
  });

  it('sorts keys of objects inside arrays and keeps the array order', () => {
    expect(
      JSON.stringify(
        sortKeysDeep([
          { b: 1, a: 2 },
          { d: 1, c: 2 },
        ]),
      ),
    ).toBe('[{"a":2,"b":1},{"c":2,"d":1}]');
  });

  it.each([null, 1, 'x', true, undefined])('returns the primitive %s unchanged', (value) => {
    expect(sortKeysDeep(value)).toBe(value);
  });

  it('sorts lexicographically, not by length as jsonb does', () => {
    expect(JSON.stringify(sortKeysDeep({ bb: 1, a: 2, ccc: 3, b: 4 }))).toBe(
      '{"a":2,"b":4,"bb":1,"ccc":3}',
    );
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(jsonArb, (value) => {
        const once = JSON.stringify(sortKeysDeep(value));
        expect(JSON.stringify(sortKeysDeep(sortKeysDeep(value)))).toBe(once);
      }),
    );
  });

  it('gives the same output for any key order of the same value', () => {
    fc.assert(
      fc.property(jsonArb, (value) => {
        expect(JSON.stringify(sortKeysDeep(reverseKeys(value)))).toBe(
          JSON.stringify(sortKeysDeep(value)),
        );
      }),
    );
  });
});

describe('computeHash', () => {
  it('matches the golden canonical form and hash', () => {
    expect(computeHash(input())).toBe(createHash('sha256').update(GOLDEN_CANONICAL).digest('hex'));
    expect(computeHash(input())).toBe(
      '0b76a1349bfd1db0067387df0923e1a28880a4edbcc3203812a3512c405bf836',
    );
  });

  it('returns 64 lowercase hex characters', () => {
    expect(computeHash(input())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores key order inside before and after at every depth', () => {
    const reordered = input({
      before: { limits: { weekly: 50, daily: 10 }, status: 'active' },
      after: { limits: { weekly: 0, daily: 0 }, status: 'banned' },
    });
    expect(computeHash(reordered)).toBe(computeHash(input()));
  });

  it('ignores key order of any payload', () => {
    fc.assert(
      fc.property(payloadArb, (payload) => {
        const a = input({ before: payload, after: payload });
        const b = input({ before: reverseRecord(payload), after: reverseRecord(payload) });
        expect(computeHash(b)).toBe(computeHash(a));
      }),
    );
  });

  it('keeps array order significant', () => {
    expect(computeHash(input({ after: { list: [1, 2] } }))).not.toBe(
      computeHash(input({ after: { list: [2, 1] } })),
    );
  });

  it.each([
    ['id', { id: '44444444-4444-4444-8444-444444444444' }],
    ['actorId', { actorId: '44444444-4444-4444-8444-444444444444' }],
    ['actorType', { actorType: 'system' }],
    ['action', { action: 'player.unban' }],
    ['resourceType', { resourceType: 'wallet' }],
    ['resourceId', { resourceId: '44444444-4444-4444-8444-444444444444' }],
    ['before', { before: { status: 'inactive' } }],
    ['after', { after: { status: 'pending' } }],
    ['nested after value', { after: { status: 'banned', limits: { daily: 0, weekly: 1 } } }],
    ['result', { result: 'failure' }],
    ['seq', { seq: 8 }],
    ['prevHash', { prevHash: 'abc124' }],
    ['createdAt', { createdAt: '2026-03-01T10:20:30.001Z' }],
  ] as const)('changes when %s changes', (_field, over) => {
    expect(computeHash(input(over))).not.toBe(computeHash(input()));
  });

  it('treats a null prevHash as an empty string', () => {
    expect(computeHash(input({ prevHash: null }))).toBe(computeHash(input({ prevHash: '' })));
  });

  it('distinguishes a null result from a set one', () => {
    expect(computeHash(input({ result: null }))).not.toBe(
      computeHash(input({ result: 'success' })),
    );
  });

  it('treats null and an empty object payload as different', () => {
    expect(computeHash(input({ before: null }))).not.toBe(computeHash(input({ before: {} })));
  });

  it('changes for any single scalar change in the payload', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        fc.pre(a !== b);
        expect(computeHash(input({ after: { note: a } }))).not.toBe(
          computeHash(input({ after: { note: b } })),
        );
      }),
    );
  });

  it('does not let a value move between neighbouring fields', () => {
    expect(computeHash(input({ action: 'a', resourceType: 'bc' }))).not.toBe(
      computeHash(input({ action: 'ab', resourceType: 'c' })),
    );
  });
});
