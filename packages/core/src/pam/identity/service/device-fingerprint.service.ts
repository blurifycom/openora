import { createHash } from 'node:crypto';

export type IpChangePolicy = 'off' | 'country' | 'any';

export type DeviceDescription = {
  label: string;
  browser: string | null;
  os: string | null;
};

const UNKNOWN_DEVICE_LABEL = 'Unknown device';

// Browsers ship a new build every few weeks and every one of them changes the
// User-Agent. Comparing raw strings would revoke every Backoffice session on each
// auto-update, so the fingerprint keeps only the major version of each token.
export function normalizeUserAgent(userAgent: string | null | undefined): string {
  if (!userAgent) {
    return '';
  }
  return userAgent
    .toLowerCase()
    .replace(/(\d+)(?:\.\d+)+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function deviceHash(userAgent: string | null | undefined): string {
  return createHash('sha256').update(normalizeUserAgent(userAgent)).digest('hex');
}

export function isSameDevice(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return normalizeUserAgent(left) === normalizeUserAgent(right);
}

const BROWSER_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/edg[ea]?\//i, 'Edge'],
  [/opr\/|opera/i, 'Opera'],
  [/chrome\/|crios\//i, 'Chrome'],
  [/firefox\/|fxios\//i, 'Firefox'],
  [/safari\//i, 'Safari'],
];

const OS_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/windows nt/i, 'Windows'],
  [/iphone|ipad|ipod/i, 'iOS'],
  [/mac os x|macintosh/i, 'macOS'],
  [/android/i, 'Android'],
  [/linux/i, 'Linux'],
];

function matchFirst(
  userAgent: string,
  patterns: ReadonlyArray<readonly [RegExp, string]>,
): string | null {
  return patterns.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;
}

/**
 * Turns a raw User-Agent into the browser/OS pair the session list shows. Deliberately
 * a handful of patterns rather than a UA-parsing dependency: the value is a display
 * label, and a wrong guess costs a cosmetic string, never an access decision.
 */
export function describeDevice(userAgent: string | null | undefined): DeviceDescription {
  if (!userAgent) {
    return { label: UNKNOWN_DEVICE_LABEL, browser: null, os: null };
  }
  const browser = matchFirst(userAgent, BROWSER_PATTERNS);
  const os = matchFirst(userAgent, OS_PATTERNS);
  if (!browser && !os) {
    return { label: UNKNOWN_DEVICE_LABEL, browser: null, os: null };
  }
  const label = [browser, os].filter((part) => part !== null).join(' on ');
  return { label, browser, os };
}

/**
 * Whether a mid-session IP change is suspicious enough to end the session.
 *
 * `country` needs both countries resolved - an unbound or failing geo-ip lookup
 * yields nulls, and an unresolved lookup must never end a session on its own.
 * `any` is the strictest setting and will log users out across NAT and mobile
 * network hops, which is why it is not the default.
 */
export function isSuspiciousIpChange({
  policy,
  sessionIp,
  requestIp,
  sessionCountry,
  requestCountry,
}: {
  policy: IpChangePolicy;
  sessionIp: string | null;
  requestIp: string | null;
  sessionCountry?: string | null;
  requestCountry?: string | null;
}): boolean {
  if (policy === 'off' || !sessionIp || !requestIp || sessionIp === requestIp) {
    return false;
  }
  if (policy === 'any') {
    return true;
  }
  if (!sessionCountry || !requestCountry) {
    return false;
  }
  return sessionCountry.toUpperCase() !== requestCountry.toUpperCase();
}

export function trustedDeviceExpiry(trustedDeviceDays: number, now = new Date()): Date {
  return new Date(now.getTime() + trustedDeviceDays * 24 * 60 * 60 * 1000);
}
