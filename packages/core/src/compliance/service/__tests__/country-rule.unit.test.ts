import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { deniesAccess, effectiveAccessOf, needsConfirmation } from '../compliance.service.js';

type Before = Parameters<typeof needsConfirmation>[0];
type Next = Parameters<typeof needsConfirmation>[1];

const MIRROR = 'https://mirror.example.com';

const before = (over: Partial<Before> = {}): Before => ({
  id: 'r1',
  countryCode: 'DE',
  action: 'allow',
  redirectIp: false,
  mirrorUrl: null,
  kycRequired: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: null,
  updatedBy: null,
  ...over,
});

const next = (over: Partial<Next> = {}): Next => ({
  blacklisted: false,
  redirectIp: false,
  mirrorUrl: null,
  kycRequired: true,
  ...over,
});

describe('deniesAccess', () => {
  it.each([
    [false, false, null, false],
    [false, true, MIRROR, false],
    [true, false, null, true],
    [true, false, MIRROR, true],
    [true, true, null, true],
    [true, true, '', true],
    [true, true, MIRROR, false],
  ])(
    'blacklisted %s redirectIp %s mirror %j denies %s',
    (blacklisted, redirectIp, mirrorUrl, expected) => {
      expect(deniesAccess({ blacklisted, redirectIp, mirrorUrl })).toBe(expected);
    },
  );
});

describe('effectiveAccessOf', () => {
  it.each([
    ['open', next(), false, 'open'],
    ['blacklisted without mirror', next({ blacklisted: true }), false, 'blocked'],
    [
      'blacklisted with mirror',
      next({ blacklisted: true, redirectIp: true, mirrorUrl: MIRROR }),
      false,
      'redirected',
    ],
    ['allowed with mirror', next({ redirectIp: true, mirrorUrl: MIRROR }), false, 'redirected'],
    ['allowed, redirect on, no mirror', next({ redirectIp: true }), false, 'open'],
    ['allowed, mirror but redirect off', next({ mirrorUrl: MIRROR }), false, 'open'],
    [
      'allowed, redirect on, empty mirror',
      next({ redirectIp: true, mirrorUrl: '' }),
      false,
      'open',
    ],
    ['open but deployment blocked', next(), true, 'blocked'],
    [
      'redirected but deployment blocked',
      next({ blacklisted: true, redirectIp: true, mirrorUrl: MIRROR }),
      true,
      'blocked',
    ],
  ] as const)('%s -> %s', (_name, rule, deploymentBlocked, expected) => {
    expect(effectiveAccessOf(rule, deploymentBlocked)).toBe(expected);
  });

  it('is blocked whenever the deployment blocks, for any rule', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.option(fc.string(), { nil: null }),
        fc.boolean(),
        (blacklisted, redirectIp, mirrorUrl, kycRequired) => {
          expect(effectiveAccessOf({ blacklisted, redirectIp, mirrorUrl, kycRequired }, true)).toBe(
            'blocked',
          );
        },
      ),
    );
  });
});

describe('needsConfirmation', () => {
  it.each([
    ['no change', before(), next(), false],
    ['blacklisting an open country', before(), next({ blacklisted: true }), true],
    ['unblacklisting a country', before({ action: 'block' }), next({ blacklisted: false }), true],
    [
      'unblacklisting a country that had a mirror',
      before({ action: 'block', redirectIp: true, mirrorUrl: MIRROR }),
      next(),
      true,
    ],
    [
      'blacklisting straight onto a mirror',
      before(),
      next({ blacklisted: true, redirectIp: true, mirrorUrl: MIRROR }),
      true,
    ],
    [
      'opening a mirror on a blacklisted country',
      before({ action: 'block' }),
      next({ blacklisted: true, redirectIp: true, mirrorUrl: MIRROR }),
      true,
    ],
    [
      'pointing a blacklisted country at a different mirror',
      before({ action: 'block', redirectIp: true, mirrorUrl: MIRROR }),
      next({ blacklisted: true, redirectIp: true, mirrorUrl: 'https://other.example.com' }),
      true,
    ],
    [
      'keeping the same mirror on a blacklisted country',
      before({ action: 'block', redirectIp: true, mirrorUrl: MIRROR }),
      next({ blacklisted: true, redirectIp: true, mirrorUrl: MIRROR }),
      false,
    ],
    [
      'closing a mirror on a blacklisted country',
      before({ action: 'block', redirectIp: true, mirrorUrl: MIRROR }),
      next({ blacklisted: true }),
      false,
    ],
    [
      'turning redirect off but keeping the url on a blacklisted country',
      before({ action: 'block', redirectIp: true, mirrorUrl: MIRROR }),
      next({ blacklisted: true, mirrorUrl: MIRROR }),
      false,
    ],
    ['dropping KYC', before(), next({ kycRequired: false }), true],
    ['requiring KYC', before({ kycRequired: false }), next({ kycRequired: true }), false],
    [
      'changing the mirror on an allowed country',
      before({ redirectIp: true, mirrorUrl: MIRROR }),
      next({ redirectIp: true, mirrorUrl: 'https://other.example.com' }),
      false,
    ],
  ])('%s -> %s', (_name, prior, change, expected) => {
    expect(needsConfirmation(prior, change)).toBe(expected);
  });

  it('never needs confirmation to close access, for any starting rule', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.option(fc.constantFrom(MIRROR, 'https://other.example.com'), { nil: null }),
        (redirectIp, kycRequired, mirrorUrl) => {
          const prior = before({ action: 'block', redirectIp, mirrorUrl, kycRequired });
          const closed = next({ blacklisted: true, kycRequired });
          if (deniesAccess({ blacklisted: true, redirectIp, mirrorUrl })) {
            return;
          }
          expect(needsConfirmation(prior, closed)).toBe(false);
        },
      ),
    );
  });

  it('needs confirmation whenever a denied country becomes reachable', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.option(fc.constantFrom(MIRROR, ''), { nil: null }),
        fc.boolean(),
        (redirectIp, mirrorUrl, nextBlacklisted) => {
          const prior = before({ action: 'block', redirectIp, mirrorUrl });
          if (!deniesAccess({ blacklisted: true, redirectIp, mirrorUrl })) {
            return;
          }
          const reachable = next({
            blacklisted: nextBlacklisted,
            redirectIp: true,
            mirrorUrl: MIRROR,
          });
          expect(needsConfirmation(prior, reachable)).toBe(true);
        },
      ),
    );
  });
});
