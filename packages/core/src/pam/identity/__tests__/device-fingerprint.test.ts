import { describe, it, expect } from 'vitest';
import {
  describeDevice,
  deviceHash,
  isSameDevice,
  isSuspiciousIpChange,
  normalizeUserAgent,
  trustedDeviceExpiry,
} from '../service/device-fingerprint.service.js';

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Safari/537.36';
const CHROME_MAC_NEXT_BUILD =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.140 Safari/537.36';
const CHROME_MAC_NEXT_MAJOR =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.6834.83 Safari/537.36';
const FIREFOX_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0';

describe('normalizeUserAgent', () => {
  it('keeps the major version and drops the rest', () => {
    expect(normalizeUserAgent('Chrome/131.0.6778.86')).toBe('chrome/131');
  });

  it('maps a missing user agent to an empty fingerprint', () => {
    expect(normalizeUserAgent(null)).toBe('');
    expect(normalizeUserAgent(undefined)).toBe('');
  });
});

describe('isSameDevice', () => {
  it('survives a patch-level browser auto-update', () => {
    expect(isSameDevice(CHROME_MAC, CHROME_MAC_NEXT_BUILD)).toBe(true);
  });

  it('treats a different browser as a different device', () => {
    expect(isSameDevice(CHROME_MAC, FIREFOX_WINDOWS)).toBe(false);
  });

  it('treats a major-version jump as a different device', () => {
    expect(isSameDevice(CHROME_MAC, CHROME_MAC_NEXT_MAJOR)).toBe(false);
  });

  it('matches two sessions that both carry no user agent', () => {
    expect(isSameDevice(null, null)).toBe(true);
  });
});

describe('deviceHash', () => {
  it('is stable across a patch-level update and differs across browsers', () => {
    expect(deviceHash(CHROME_MAC)).toBe(deviceHash(CHROME_MAC_NEXT_BUILD));
    expect(deviceHash(CHROME_MAC)).not.toBe(deviceHash(FIREFOX_WINDOWS));
  });
});

describe('describeDevice', () => {
  it('renders browser and operating system', () => {
    expect(describeDevice(CHROME_MAC)).toEqual({
      label: 'Chrome on macOS',
      browser: 'Chrome',
      os: 'macOS',
    });
    expect(describeDevice(FIREFOX_WINDOWS)).toEqual({
      label: 'Firefox on Windows',
      browser: 'Firefox',
      os: 'Windows',
    });
  });

  it('does not report Chrome for an Edge user agent', () => {
    const edge = `${CHROME_MAC} Edg/131.0.2903.86`;
    expect(describeDevice(edge).browser).toBe('Edge');
  });

  it('falls back to a placeholder when nothing is recognisable', () => {
    expect(describeDevice(null)).toEqual({ label: 'Unknown device', browser: null, os: null });
    expect(describeDevice('curl/8.4.0')).toEqual({
      label: 'Unknown device',
      browser: null,
      os: null,
    });
  });
});

describe('isSuspiciousIpChange', () => {
  const base = { sessionIp: '10.0.0.1', requestIp: '10.0.0.2' };

  it('ignores every change while the policy is off', () => {
    expect(isSuspiciousIpChange({ ...base, policy: 'off' })).toBe(false);
  });

  it('flags any change under the any policy', () => {
    expect(isSuspiciousIpChange({ ...base, policy: 'any' })).toBe(true);
  });

  it('ignores an unchanged address under every policy', () => {
    expect(
      isSuspiciousIpChange({ policy: 'any', sessionIp: '10.0.0.1', requestIp: '10.0.0.1' }),
    ).toBe(false);
  });

  it('flags a country hop and tolerates a same-country hop', () => {
    expect(
      isSuspiciousIpChange({
        ...base,
        policy: 'country',
        sessionCountry: 'PL',
        requestCountry: 'RU',
      }),
    ).toBe(true);
    expect(
      isSuspiciousIpChange({
        ...base,
        policy: 'country',
        sessionCountry: 'PL',
        requestCountry: 'pl',
      }),
    ).toBe(false);
  });

  it('does not end a session when the country cannot be resolved', () => {
    expect(
      isSuspiciousIpChange({
        ...base,
        policy: 'country',
        sessionCountry: null,
        requestCountry: 'RU',
      }),
    ).toBe(false);
  });

  it('does not end a session when either address is unknown', () => {
    expect(isSuspiciousIpChange({ policy: 'any', sessionIp: null, requestIp: '10.0.0.2' })).toBe(
      false,
    );
  });
});

describe('trustedDeviceExpiry', () => {
  it('adds the configured number of days to the grant date', () => {
    const now = new Date('2026-08-25T00:00:00.000Z');
    expect(trustedDeviceExpiry(30, now).toISOString()).toBe('2026-09-24T00:00:00.000Z');
  });
});
