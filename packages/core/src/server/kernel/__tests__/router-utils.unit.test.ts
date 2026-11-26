import { describe, expect, it } from 'vitest';
import { parseInternalCallers } from '../router-utils.js';

describe('parseInternalCallers', () => {
  it.each([
    [undefined, []],
    ['', []],
    [' , ,, ', []],
    ['wallet', ['wallet']],
    ['wallet,casino', ['wallet', 'casino']],
    [' wallet , casino ', ['wallet', 'casino']],
    ['wallet,wallet', ['wallet']],
    ['wallet,,casino,', ['wallet', 'casino']],
  ])('parses %j', (raw, expected) => {
    expect([...parseInternalCallers(raw)]).toEqual(expected);
  });

  it('keeps names case sensitive so a different service name is not allowed', () => {
    const callers = parseInternalCallers('Wallet');
    expect(callers.has('wallet')).toBe(false);
  });

  it('does not split on spaces inside a name', () => {
    expect([...parseInternalCallers('wallet casino')]).toEqual(['wallet casino']);
  });
});
