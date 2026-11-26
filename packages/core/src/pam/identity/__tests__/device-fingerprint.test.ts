import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  describeDevice,
  deviceHash,
  isSameDevice,
  isSuspiciousIpChange,
  trustedDeviceExpiry,
} from '../service/device-fingerprint.service.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.71 Safari/537.36';
const CHROME_WIN_BUMP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.109 Safari/537.36';
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FIREFOX_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0';
const EDGE_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
const OPERA_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0';
const SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15';
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

describe('normalizeUserAgent and deviceHash', () => {
  it('a null or undefined user agent normalises to the empty value', () => {
    expect(deviceHash(null)).toBe(sha(''));
    expect(deviceHash(undefined)).toBe(sha(''));
    expect(deviceHash('')).toBe(sha(''));
  });

  it('case and repeated whitespace do not change the hash', () => {
    expect(deviceHash('  Foo   BAR\tbaz ')).toBe(deviceHash('foo bar baz'));
  });

  it('a minor browser version bump does not change the hash', () => {
    expect(deviceHash(CHROME_WIN)).toBe(deviceHash(CHROME_WIN_BUMP));
    expect(deviceHash('Chrome/120.0.1')).not.toBe(deviceHash('Chrome/121.0.1'));
  });

  it('a different browser or operating system changes the hash', () => {
    expect(deviceHash(CHROME_WIN)).not.toBe(deviceHash(FIREFOX_WIN));
    expect(deviceHash(CHROME_WIN)).not.toBe(deviceHash(CHROME_MAC));
  });
});

describe('isSameDevice', () => {
  it('two user agents differing only by minor version are the same device', () => {
    expect(isSameDevice(CHROME_WIN, CHROME_WIN_BUMP)).toBe(true);
  });

  it('two user agents of different browsers are different devices', () => {
    expect(isSameDevice(CHROME_WIN, FIREFOX_WIN)).toBe(false);
  });

  it('two missing user agents are the same device', () => {
    expect(isSameDevice(null, undefined)).toBe(true);
    expect(isSameDevice(null, CHROME_WIN)).toBe(false);
  });
});

describe('describeDevice', () => {
  it('a missing user agent is labelled unknown', () => {
    expect(describeDevice(null)).toEqual({ label: 'Unknown device', browser: null, os: null });
    expect(describeDevice(undefined).label).toBe('Unknown device');
    expect(describeDevice('').label).toBe('Unknown device');
  });

  it('an unrecognised user agent is labelled unknown', () => {
    expect(describeDevice('curl/8.4.0')).toEqual({
      label: 'Unknown device',
      browser: null,
      os: null,
    });
  });

  it('Edge is detected before Chrome', () => {
    expect(describeDevice(EDGE_WIN).browser).toBe('Edge');
  });

  it('Opera is detected before Chrome', () => {
    expect(describeDevice(OPERA_WIN).browser).toBe('Opera');
  });

  it('Chrome on Windows, Safari on macOS, Firefox on Linux and Chrome on Android get a browser on operating system label', () => {
    expect(describeDevice(CHROME_WIN).label).toBe('Chrome on Windows');
    expect(describeDevice(SAFARI_MAC).label).toBe('Safari on macOS');
    expect(describeDevice(FIREFOX_LINUX).label).toBe('Firefox on Linux');
    expect(describeDevice(CHROME_ANDROID).label).toBe('Chrome on Android');
  });

  it('iPhone and iPad user agents are labelled iOS', () => {
    const iphone =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1';
    const ipad =
      'Mozilla/5.0 (iPad; CPU OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1';
    expect(describeDevice(iphone)).toEqual({
      label: 'Safari on iOS',
      browser: 'Safari',
      os: 'iOS',
    });
    expect(describeDevice(ipad).os).toBe('iOS');
  });

  it('a known operating system with an unknown browser returns only the operating system', () => {
    expect(describeDevice('SomeApp (Windows NT 10.0)')).toEqual({
      label: 'Windows',
      browser: null,
      os: 'Windows',
    });
  });
});

describe('isSuspiciousIpChange', () => {
  const base = { sessionIp: '1.1.1.1', requestIp: '2.2.2.2' };

  it('policy off never flags a change', () => {
    expect(
      isSuspiciousIpChange({
        ...base,
        policy: 'off',
        sessionCountry: 'US',
        requestCountry: 'DE',
      }),
    ).toBe(false);
  });

  it('a missing session ip or request ip never flags', () => {
    for (const policy of ['any', 'country'] as const) {
      expect(
        isSuspiciousIpChange({
          policy,
          sessionIp: null,
          requestIp: '2.2.2.2',
          sessionCountry: 'US',
          requestCountry: 'DE',
        }),
      ).toBe(false);
      expect(
        isSuspiciousIpChange({
          policy,
          sessionIp: '1.1.1.1',
          requestIp: null,
          sessionCountry: 'US',
          requestCountry: 'DE',
        }),
      ).toBe(false);
    }
  });

  it('an identical ip never flags', () => {
    expect(
      isSuspiciousIpChange({
        policy: 'any',
        sessionIp: '1.1.1.1',
        requestIp: '1.1.1.1',
      }),
    ).toBe(false);
  });

  it('policy any flags every different ip', () => {
    expect(isSuspiciousIpChange({ ...base, policy: 'any' })).toBe(true);
  });

  it('policy country flags a change between two different countries', () => {
    expect(
      isSuspiciousIpChange({
        ...base,
        policy: 'country',
        sessionCountry: 'US',
        requestCountry: 'DE',
      }),
    ).toBe(true);
    expect(
      isSuspiciousIpChange({
        ...base,
        policy: 'country',
        sessionCountry: 'US',
        requestCountry: 'US',
      }),
    ).toBe(false);
  });

  it('policy country does not flag when either country is unresolved', () => {
    expect(isSuspiciousIpChange({ ...base, policy: 'country', requestCountry: 'DE' })).toBe(false);
    expect(isSuspiciousIpChange({ ...base, policy: 'country', sessionCountry: 'US' })).toBe(false);
    expect(
      isSuspiciousIpChange({
        ...base,
        policy: 'country',
        sessionCountry: null,
        requestCountry: null,
      }),
    ).toBe(false);
  });

  it('policy country compares countries case insensitively', () => {
    expect(
      isSuspiciousIpChange({
        ...base,
        policy: 'country',
        sessionCountry: 'us',
        requestCountry: 'US',
      }),
    ).toBe(false);
  });
});

describe('trustedDeviceExpiry', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it('adds the configured number of days to the given time', () => {
    expect(trustedDeviceExpiry(30, now).toISOString()).toBe('2026-01-31T00:00:00.000Z');
  });

  it('zero days returns the given time', () => {
    expect(trustedDeviceExpiry(0, now).getTime()).toBe(now.getTime());
  });
});
