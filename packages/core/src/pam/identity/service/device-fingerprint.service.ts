import { createHash } from 'node:crypto';

export type IpChangePolicy = 'off' | 'country' | 'any';

export type DeviceDescription = {
  label: string;
  browser: string | null;
  os: string | null;
};

const UNKNOWN_DEVICE_LABEL = 'Unknown device';

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
