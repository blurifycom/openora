import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { maskEmail, maskPhone } from '../two-factor-delivery.service.js';
import { isLostBackupCodeRace } from '../two-factor-challenge.service.js';
import { pendingIdentifier } from '../two-factor-lockout.service.js';

describe('maskEmail', () => {
  it.each([
    ['alice@example.com', 'a***@example.com'],
    ['ab@example.com', 'a***@example.com'],
    ['a@example.com', '***@example.com'],
    ['@example.com', '***@example.com'],
    ['nodomain', 'n***@'],
    ['', '***@'],
  ])('masks %j as %j', (email, expected) => {
    expect(maskEmail(email)).toBe(expected);
  });

  it('never shows a one character local part', () => {
    expect(maskEmail('q@example.com')).not.toContain('q');
  });

  it('keeps at most the first character of the local part', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9]{3,20}$/),
        fc.stringMatching(/^[A-Z]{3,10}\.com$/),
        (local, domain) => {
          const masked = maskEmail(`${local}@${domain}`);
          expect(masked).toBe(`${local[0]}***@${domain}`);
          expect(masked).not.toContain(local);
        },
      ),
    );
  });
});

describe('maskPhone', () => {
  it.each([
    ['+380501234567', '+** *** *** 67'],
    ['+447911123456', '+** *** *** 56'],
    ['12', '+** *** *** 12'],
    ['', '+** *** *** '],
  ])('masks %j as %j', (phone, expected) => {
    expect(maskPhone(phone)).toBe(expected);
  });

  it('shows nothing of the number but its last two characters', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^\+[1-9][0-9]{8,14}$/), (phone) => {
        const masked = maskPhone(phone);
        expect(masked.endsWith(phone.slice(-2))).toBe(true);
        expect(masked.replace(/\D/g, '')).toBe(phone.slice(-2));
      }),
    );
  });

  it('leaks at most two digits of a one digit input only once', () => {
    expect(maskPhone('7').replace(/\D/g, '')).toBe('7');
  });
});

describe('pendingIdentifier', () => {
  it.each([
    ['2fa-abc123.signature', '2fa-abc123'],
    ['2fa-abc123', '2fa-abc123'],
    ['2fa-abc.sig.more', '2fa-abc'],
    ['2fa-', '2fa-'],
  ])('reads %j as %j', (cookie, expected) => {
    expect(pendingIdentifier(cookie)).toBe(expected);
  });

  it.each([
    [undefined],
    [''],
    ['abc123.signature'],
    ['.2fa-abc'],
    ['2FA-abc.sig'],
    [' 2fa-abc.sig'],
    ['x2fa-abc.sig'],
    ['2fa.abc'],
  ])('returns undefined for %j', (cookie) => {
    expect(pendingIdentifier(cookie)).toBeUndefined();
  });

  it('never returns an identifier holding the signature part', () => {
    fc.assert(
      fc.property(fc.string(), (cookie) => {
        const id = pendingIdentifier(cookie);
        if (id !== undefined) {
          expect(id.includes('.')).toBe(false);
          expect(id.startsWith('2fa-')).toBe(true);
        }
      }),
    );
  });
});

describe('isLostBackupCodeRace', () => {
  it.each([
    [409, true],
    [200, false],
    [400, false],
    [401, false],
    [403, false],
    [429, false],
    [500, false],
  ])('status %i gives %s', (status, expected) => {
    expect(isLostBackupCodeRace(new Response(null, { status }))).toBe(expected);
  });
});
