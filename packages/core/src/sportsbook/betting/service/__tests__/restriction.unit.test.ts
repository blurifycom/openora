import { describe, expect, it } from 'vitest';
import type { SportsbookRestriction } from '../../contract/index.js';
import { changed } from '../restriction.service.js';

const restriction = (over: Partial<SportsbookRestriction> = {}): SportsbookRestriction => ({
  userId: '22222222-2222-4222-8222-222222222222',
  restricted: true,
  reason: 'fraud',
  createdAt: '2026-03-01T12:00:00.000Z',
  ...over,
});

describe('changed', () => {
  it.each<[string, Partial<SportsbookRestriction>, boolean]>([
    ['the same restriction', {}, false],
    ['a lifted restriction', { restricted: false, reason: null, createdAt: null }, true],
    ['the flag alone', { restricted: false }, true],
    ['a new reason', { reason: 'abuse' }, true],
    ['a reason in another case', { reason: 'Fraud' }, true],
    ['a reason cleared to null', { reason: null }, true],
    ['an empty reason against null', { reason: '' }, true],
    ['only a new created time', { createdAt: '2026-03-02T12:00:00.000Z' }, false],
    ['only another user id', { userId: '44444444-4444-4444-8444-444444444444' }, false],
  ])('%s is %s', (_name, over, expected) => {
    expect(changed(restriction(), restriction(over))).toBe(expected);
  });

  it('is symmetric', () => {
    const before = restriction();
    const after = restriction({ restricted: false, reason: null });
    expect(changed(before, after)).toBe(changed(after, before));
  });

  it('sees no change between two unrestricted players', () => {
    const none = { restricted: false, reason: null, createdAt: null };
    expect(changed(restriction(none), restriction(none))).toBe(false);
  });
});
