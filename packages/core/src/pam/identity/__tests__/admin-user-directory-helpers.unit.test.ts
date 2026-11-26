import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { automaticMcpRevokeReason, escapeLikePattern } from '../admin-user-directory.js';

describe('automaticMcpRevokeReason', () => {
  it.each([
    [{ isActive: false }, 'admin_disabled'],
    [{ isActive: false, role: 'admin' }, 'admin_disabled'],
    [{ isActive: false, role: 'support' }, 'admin_disabled'],
    [{ role: 'support' }, 'admin_role_removed'],
    [{ role: 'player' }, 'admin_role_removed'],
    [{ role: '' }, 'admin_role_removed'],
    [{ role: 'Admin' }, 'admin_role_removed'],
    [{ isActive: true, role: 'support' }, 'admin_role_removed'],
    [{ role: 'admin' }, null],
    [{ isActive: true }, null],
    [{ isActive: true, role: 'admin' }, null],
    [{}, null],
    [{ isActive: undefined, role: undefined }, null],
  ])('patch %j gives %j', (patch, expected) => {
    expect(automaticMcpRevokeReason(patch)).toBe(expected);
  });
});

const escapeRegex = (char: string) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const likeMatches = (pattern: string, text: string) => {
  let source = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern.charAt(i);
    if (char === '\\') {
      i += 1;
      source += escapeRegex(pattern.charAt(i) || '\\');
    } else if (char === '%') {
      source += '[\\s\\S]*';
    } else if (char === '_') {
      source += '[\\s\\S]';
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`${source}$`, 'u').test(text);
};

describe('escapeLikePattern', () => {
  it.each([
    ['plain', 'plain'],
    ['100%', '100\\%'],
    ['a_b', 'a\\_b'],
    ['a\\b', 'a\\\\b'],
    ['\\%', '\\\\\\%'],
    ['%_\\', '\\%\\_\\\\'],
    ['', ''],
    ['ünï_çødé', 'ünï\\_çødé'],
  ])('escapes %j to %j', (input, expected) => {
    expect(escapeLikePattern(input)).toBe(expected);
  });

  it('makes an escaped string match only itself', () => {
    const text = fc.string({ unit: fc.constantFrom('a', 'b', '%', '_', '\\', ' ', 'é') });
    fc.assert(
      fc.property(text, text, (value, other) => {
        const pattern = escapeLikePattern(value);
        expect(likeMatches(pattern, value)).toBe(true);
        expect(likeMatches(pattern, other)).toBe(other === value);
      }),
    );
  });

  it('keeps a wildcard from matching other text', () => {
    expect(likeMatches(escapeLikePattern('%'), 'anything')).toBe(false);
    expect(likeMatches(escapeLikePattern('_'), 'x')).toBe(false);
  });
});
