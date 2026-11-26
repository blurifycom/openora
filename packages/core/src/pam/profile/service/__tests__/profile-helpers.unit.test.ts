import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BioBlockedError, moderateBio, pickChanged, pickFields } from '../profile.service.js';

describe('pickFields', () => {
  const at = new Date('2026-03-01T10:00:00.000Z');

  it('keeps only the named keys', () => {
    expect(pickFields({ a: 1, b: 2, c: 3 }, ['a', 'c'])).toEqual({ a: 1, c: 3 });
  });

  it('turns dates into ISO strings so the audit hash survives the jsonb read-back', () => {
    const picked = pickFields({ seen: at, name: 'x' }, ['seen', 'name']);
    expect(picked).toEqual({ seen: '2026-03-01T10:00:00.000Z', name: 'x' });
    expect(JSON.parse(JSON.stringify(picked))).toEqual(picked);
  });

  it.each([null, undefined, 0, '', false])('keeps %j as it is', (value) => {
    expect(pickFields({ v: value }, ['v'])).toEqual({ v: value });
  });

  it('gives an empty object for no keys', () => {
    expect(pickFields({ a: 1 }, [])).toEqual({});
  });

  it('does not mutate the row', () => {
    const row = { seen: at };
    pickFields(row, ['seen']);
    expect(row.seen).toBe(at);
  });

  it('leaves a nested date untouched', () => {
    const nested = { inner: at };
    expect(pickFields({ nested }, ['nested']).nested).toBe(nested);
  });
});

describe('pickChanged', () => {
  const row = { bio: 'hello', country: 'DE', nickname: null as string | null };

  it.each([
    [{ bio: 'hello' }, {}],
    [{ bio: 'bye' }, { bio: 'bye' }],
    [{ bio: undefined }, {}],
    [{ nickname: null }, {}],
    [{ nickname: 'nick' }, { nickname: 'nick' }],
    [{ bio: 'bye', country: 'DE' }, { bio: 'bye' }],
    [{}, {}],
  ])('candidate %j changes %j', (candidate, expected) => {
    expect(pickChanged(row, candidate)).toEqual(expected);
  });

  it('counts a cleared value as a change', () => {
    expect(pickChanged({ bio: 'hello' as string | null }, { bio: null })).toEqual({ bio: null });
  });

  it('treats an empty string as different from null', () => {
    expect(pickChanged({ bio: null as string | null }, { bio: '' })).toEqual({ bio: '' });
  });

  it('is empty when the candidate equals the row', () => {
    fc.assert(
      fc.property(fc.record({ a: fc.string(), b: fc.integer(), c: fc.boolean() }), (value) => {
        expect(pickChanged(value, { ...value })).toEqual({});
      }),
    );
  });

  it('never returns a key the row already holds with the same value', () => {
    fc.assert(
      fc.property(
        fc.record({ a: fc.string(), b: fc.integer() }),
        fc.record({ a: fc.string(), b: fc.integer() }),
        (current, candidate) => {
          const changed = pickChanged(current, candidate);
          expect(
            changed.a === undefined ? current.a === candidate.a : changed.a === candidate.a,
          ).toBe(true);
          expect('b' in changed).toBe(current.b !== candidate.b);
        },
      ),
    );
  });
});

describe('moderateBio', () => {
  it('passes clean text through', () => {
    expect(moderateBio('Loves slots and tea')).toBe('Loves slots and tea');
  });

  it.each([
    ['javascript:alert(1)', 'javascript alert(1)'],
    ['JAVASCRIPT :x', 'JAVASCRIPT x'],
    ['data:text/html,x', 'data text/html,x'],
  ])('defangs the scheme in %j', (input, expected) => {
    expect(moderateBio(input)).toBe(expected);
  });

  it.each(['fuck you', 'FUCK', 'well, fuck'])('throws BioBlockedError for profanity %j', (bio) => {
    expect(() => moderateBio(bio)).toThrow(BioBlockedError);
  });
});
