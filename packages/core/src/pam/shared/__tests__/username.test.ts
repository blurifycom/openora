import { describe, it, expect } from 'vitest';
import { assertUsernameAllowed, isUsernameAllowed, UsernameBlockedError } from '../username.js';

describe('isUsernameAllowed', () => {
  it.each(['admin', 'ADMIN', 'support_1', 'real-admin', 'mod_7', 'the_official_1', '1root'])(
    'refuses the reserved handle %s',
    (username) => {
      expect(isUsernameAllowed(username)).toBe(false);
    },
  );

  it('refuses profanity even when separators and digits hide the word boundary', () => {
    expect(isUsernameAllowed('shit_42')).toBe(false);
    expect(isUsernameAllowed('big_ass')).toBe(false);
  });

  it('matches a reserved word only as a whole word, not inside a longer one', () => {
    expect(isUsernameAllowed('modest_player')).toBe(true);
    expect(isUsernameAllowed('helpful99')).toBe(true);
    expect(isUsernameAllowed('lucky_ace')).toBe(true);
  });

  it('adds operator-reserved handles, normalised the same way', () => {
    expect(isUsernameAllowed('acmebet_vip', ['AcmeBet'])).toBe(false);
    expect(isUsernameAllowed('acme_bet_2', ['Acme Bet'])).toBe(false);
    expect(isUsernameAllowed('acmebet_vip')).toBe(true);
  });
});

describe('assertUsernameAllowed', () => {
  it('throws the blocked error for a refused handle and passes a clean one', () => {
    expect(() => assertUsernameAllowed('support_1')).toThrow(UsernameBlockedError);
    expect(() => assertUsernameAllowed('lucky_ace')).not.toThrow();
  });
});
