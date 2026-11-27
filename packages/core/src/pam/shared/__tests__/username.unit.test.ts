import { describe, expect, it } from 'vitest';
import {
  assertUsernameAllowed,
  isReserved,
  isUsernameAllowed,
  UsernameBlockedError,
} from '../username.js';

describe('isUsernameAllowed reserved handles', () => {
  it.each([
    'admin',
    'ADMIN',
    'AdMiN',
    'admin_1',
    'admin123',
    '1admin',
    'admin.',
    '_admin_',
    'the-admin',
    'support_team',
    'Support.Team',
    'mod_7',
    'mod7',
    'root',
    'system',
    'official-casino',
    'noreply',
    'bot_42',
  ])('blocks %s', (name) => {
    expect(isUsernameAllowed(name)).toBe(false);
  });

  it.each(['modest', 'modern', 'moderate', 'robot', 'rooted', 'botany', 'supporter', 'helpful'])(
    'allows %s, a longer word that only contains a reserved one',
    (name) => {
      expect(isUsernameAllowed(name)).toBe(true);
    },
  );

  it.each(['lucky_player', 'jackpot99', 'Zoë', 'björn_77', 'щасливчик'])('allows %s', (name) => {
    expect(isUsernameAllowed(name)).toBe(true);
  });

  it('allows an empty and a digits-only handle', () => {
    expect(isUsernameAllowed('')).toBe(true);
    expect(isUsernameAllowed('12345')).toBe(true);
  });
});

describe('isUsernameAllowed operator reserved list', () => {
  it('blocks an operator word and its separator variants', () => {
    expect(isUsernameAllowed('luckybay', ['luckybay'])).toBe(false);
    expect(isUsernameAllowed('LuckyBay_Vip', ['luckybay'])).toBe(false);
    expect(isUsernameAllowed('luckybay99', ['luckybay'])).toBe(false);
  });

  it('allows the same word without the operator list', () => {
    expect(isUsernameAllowed('luckybay')).toBe(true);
  });

  it('does not block a longer word containing an operator word', () => {
    expect(isUsernameAllowed('luckybaying', ['luckybay'])).toBe(true);
  });

  it('matches a multi word operator entry written with any separator', () => {
    expect(isUsernameAllowed('vip_desk', ['vip desk'])).toBe(false);
    expect(isUsernameAllowed('vip-desk-3', ['VIP-Desk'])).toBe(false);
    expect(isUsernameAllowed('vip', ['vip desk'])).toBe(true);
  });

  it('ignores an operator entry that holds no letters', () => {
    expect(isUsernameAllowed('anything', ['123', '', '___'])).toBe(true);
  });

  it('keeps the built-in list when an operator list is given', () => {
    expect(isUsernameAllowed('admin', ['luckybay'])).toBe(false);
  });
});

describe('isUsernameAllowed evasion', () => {
  it.each([
    ['fullwidth letters', 'ａｄｍｉｎ'],
    ['zero width space inside', 'ad​min'],
    ['soft hyphen inside', 'ad­min'],
    ['combining mark after a letter', 'admín'],
  ])('blocks the reserved word with %s', (_name, name) => {
    expect(isUsernameAllowed(name)).toBe(false);
  });

  it.each([
    ['separated by underscores', 'big_ass_1'],
    ['digits between', 'big1ass'],
    ['uppercase', 'BIG_ASS'],
  ])('blocks profanity %s', (_name, name) => {
    expect(isUsernameAllowed(name)).toBe(false);
  });
});

describe('isReserved', () => {
  it('matches a whole word run only', () => {
    expect(isReserved('mod', [])).toBe(true);
    expect(isReserved('my mod squad', [])).toBe(true);
    expect(isReserved('modest', [])).toBe(false);
    expect(isReserved('', [])).toBe(false);
  });

  it('normalises operator entries to words', () => {
    expect(isReserved('acme', ['ACME!'])).toBe(true);
  });
});

describe('assertUsernameAllowed', () => {
  it('throws UsernameBlockedError for a reserved handle', () => {
    expect(() => assertUsernameAllowed('Admin_2')).toThrow(UsernameBlockedError);
  });

  it('throws for an operator reserved handle', () => {
    expect(() => assertUsernameAllowed('acme_staff', ['acme'])).toThrow(UsernameBlockedError);
  });

  it('returns for an allowed handle', () => {
    expect(() => assertUsernameAllowed('modest')).not.toThrow();
  });
});
