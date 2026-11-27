import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  deviceHash,
  isSameDevice,
  isSuspiciousIpChange,
  normalizeUserAgent,
  trustedDeviceExpiry,
  type IpChangePolicy,
} from '../device-fingerprint.service.js';

const chrome = (version: string) =>
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;

describe('isSuspiciousIpChange', () => {
  const ips = { sessionIp: '1.1.1.1', requestIp: '2.2.2.2' };

  it.each([
    ['off', 'DE', 'US', false],
    ['country', 'DE', 'US', true],
    ['country', 'DE', 'de', false],
    ['country', 'de', 'DE', false],
    ['country', 'DE', 'DE', false],
    ['country', null, 'US', false],
    ['country', 'DE', null, false],
    ['country', undefined, undefined, false],
    ['country', '', 'US', false],
    ['any', null, null, true],
    ['any', 'DE', 'DE', true],
  ] as const)(
    'policy %s with countries %s -> %s is %s',
    (policy, sessionCountry, requestCountry, expected) => {
      expect(isSuspiciousIpChange({ policy, ...ips, sessionCountry, requestCountry })).toBe(
        expected,
      );
    },
  );

  it.each([
    ['same ip', '1.1.1.1', '1.1.1.1'],
    ['no session ip', null, '2.2.2.2'],
    ['no request ip', '1.1.1.1', null],
    ['empty session ip', '', '2.2.2.2'],
  ] as const)('is never suspicious for %s under any policy', (_name, sessionIp, requestIp) => {
    for (const policy of ['off', 'country', 'any'] as const) {
      expect(
        isSuspiciousIpChange({
          policy,
          sessionIp,
          requestIp,
          sessionCountry: 'DE',
          requestCountry: 'US',
        }),
      ).toBe(false);
    }
  });

  it('is never suspicious under off, whatever the inputs', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), fc.string(), (a, b, c, d) => {
        expect(
          isSuspiciousIpChange({
            policy: 'off',
            sessionIp: a,
            requestIp: b,
            sessionCountry: c,
            requestCountry: d,
          }),
        ).toBe(false);
      }),
    );
  });

  it('flags any differing ip under any, symmetric in its arguments', () => {
    fc.assert(
      fc.property(fc.ipV4(), fc.ipV4(), (a, b) => {
        const policy: IpChangePolicy = 'any';
        const forward = isSuspiciousIpChange({ policy, sessionIp: a, requestIp: b });
        const backward = isSuspiciousIpChange({ policy, sessionIp: b, requestIp: a });
        expect(forward).toBe(a !== b);
        expect(backward).toBe(forward);
      }),
    );
  });
});

describe('normalizeUserAgent', () => {
  it('returns an empty string for missing input', () => {
    expect(normalizeUserAgent(null)).toBe('');
    expect(normalizeUserAgent(undefined)).toBe('');
    expect(normalizeUserAgent('')).toBe('');
  });

  it('keeps the hash across a minor and patch browser update', () => {
    expect(deviceHash(chrome('126.0.6478.127'))).toBe(deviceHash(chrome('126.0.6478.183')));
    expect(isSameDevice(chrome('126.0.1.1'), chrome('126.2.9.9'))).toBe(true);
  });

  it('changes the hash on a major version bump', () => {
    expect(deviceHash(chrome('126.0.6478.127'))).not.toBe(deviceHash(chrome('127.0.6478.127')));
    expect(isSameDevice(chrome('126.0.0.0'), chrome('127.0.0.0'))).toBe(false);
  });

  it('changes the hash when the browser or os changes', () => {
    const firefox =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:126.0) Gecko/20100101 Firefox/126.0';
    expect(deviceHash(chrome('126.0.0.0'))).not.toBe(deviceHash(firefox));
    expect(
      isSameDevice(chrome('126.0.0.0'), chrome('126.0.0.0').replace('Macintosh', 'Windows')),
    ).toBe(false);
  });

  it('ignores case and whitespace differences', () => {
    expect(normalizeUserAgent('  Foo/1.2   BAR ')).toBe('foo/1 bar');
  });

  it('hashes to 64 hex characters, equal to itself', () => {
    fc.assert(
      fc.property(fc.string(), (ua) => {
        expect(deviceHash(ua)).toMatch(/^[0-9a-f]{64}$/);
        expect(deviceHash(ua)).toBe(deviceHash(ua));
      }),
    );
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.string(), (ua) => {
        expect(normalizeUserAgent(normalizeUserAgent(ua))).toBe(normalizeUserAgent(ua));
      }),
    );
  });

  it('keeps the hash for any dotted version tail', () => {
    fc.assert(
      fc.property(
        fc.nat(300),
        fc.array(fc.nat(9999), { minLength: 1, maxLength: 4 }),
        fc.array(fc.nat(9999), { minLength: 1, maxLength: 4 }),
        (major, tailA, tailB) => {
          const a = chrome([major, ...tailA].join('.'));
          const b = chrome([major, ...tailB].join('.'));
          expect(deviceHash(a)).toBe(deviceHash(b));
        },
      ),
    );
  });
});

describe('trustedDeviceExpiry', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it.each([
    [0, '2026-01-01T00:00:00.000Z'],
    [1, '2026-01-02T00:00:00.000Z'],
    [30, '2026-01-31T00:00:00.000Z'],
  ])('%i days from now is %s', (days, iso) => {
    expect(trustedDeviceExpiry(days, now).toISOString()).toBe(iso);
  });

  it('does not mutate the date it is given', () => {
    trustedDeviceExpiry(30, now);
    expect(now.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('is exactly days times 24h after now', () => {
    fc.assert(
      fc.property(fc.nat(3650), (days) => {
        expect(trustedDeviceExpiry(days, now).getTime() - now.getTime()).toBe(
          days * 24 * 60 * 60 * 1000,
        );
      }),
    );
  });
});
