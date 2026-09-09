import { describe, it, expect } from 'vitest';
import { maskEmail, maskPhone } from '../service/two-factor-delivery.service.js';

describe('maskEmail', () => {
  it('keeps the first character and the domain', () => {
    expect(maskEmail('player@example.com')).toBe('p***@example.com');
  });

  it('hides a one-character local part entirely', () => {
    // Keeping the single character would spell out the whole address.
    expect(maskEmail('p@example.com')).toBe('***@example.com');
  });

  it('masks a local part regardless of its length', () => {
    expect(maskEmail('averylongaddress@example.com')).toBe('a***@example.com');
  });
});

describe('maskPhone', () => {
  it('keeps only the last two digits', () => {
    expect(maskPhone('+48123456742')).toBe('+** *** *** 42');
  });

  it('does not widen the reveal for a short number', () => {
    expect(maskPhone('+4812')).toBe('+** *** *** 12');
  });
});
