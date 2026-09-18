import { BlockList, isIP } from 'node:net';

// Loopback plus the RFC 1918 / RFC 4193 private ranges: a reverse proxy on the same host or
// on the deployment's private network. A caller reaching Node from a public address is never
// in this list, so it cannot choose its own IP by sending a forwarding header.
export const DEFAULT_TRUSTED_PROXIES: readonly string[] = [
  '127.0.0.0/8',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fc00::/7',
];

export type TrustedProxies = { contains(address: string): boolean };

function normalizeAddress(address: string): string {
  // Node reports an IPv4 peer on a dual-stack socket as `::ffff:a.b.c.d`.
  return address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
}

// Throws on an entry that is neither an IP nor a CIDR, so a typo in the list fails the boot
// instead of silently trusting nobody (or everybody behind the proxy it meant to name).
export function parseTrustedProxies(entries: readonly string[]): TrustedProxies {
  const list = new BlockList();
  for (const raw of entries) {
    const entry = raw.trim();
    const [address = '', prefixText] = entry.split('/');
    const family = isIP(address);
    const prefix = prefixText === undefined ? undefined : Number(prefixText);
    const maxPrefix = family === 4 ? 32 : 128;
    if (
      family === 0 ||
      (prefix !== undefined && (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix))
    ) {
      throw new Error(`Invalid trusted proxy entry "${raw}": expected an IP address or CIDR.`);
    }
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) {
      list.addAddress(address, type);
    } else {
      list.addSubnet(address, prefix, type);
    }
  }
  return {
    contains(address) {
      const normalized = normalizeAddress(address);
      const family = isIP(normalized);
      return family !== 0 && list.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
    },
  };
}

// `TRUSTED_PROXIES` is a comma-separated list; an empty value trusts no proxy at all.
export function resolveTrustedProxies(
  configured: readonly string[] | undefined,
  env: string | undefined,
): TrustedProxies {
  if (configured) {
    return parseTrustedProxies(configured);
  }
  if (env !== undefined) {
    return parseTrustedProxies(env.split(',').filter((entry) => entry.trim() !== ''));
  }
  return parseTrustedProxies(DEFAULT_TRUSTED_PROXIES);
}

// The one place a request's client address is decided. Every per-IP throttle, geo check and
// audit row downstream reads `X-Real-IP` (and `X-Forwarded-For` behind `trustForwarded`), so
// those headers are only left as sent when the peer that sent them is a trusted proxy. Any
// other peer gets its socket address written over `X-Real-IP` and its `X-Forwarded-For`
// dropped - rotating either header then buys a direct caller nothing.
//
// No peer address means the request never crossed a socket (an in-process `app.request`),
// so there is no network caller to distrust and the headers are left alone.
export function applyClientAddress(
  headers: Record<string, string>,
  peerAddress: string | undefined,
  trustedProxies: TrustedProxies,
): void {
  if (!peerAddress) {
    return;
  }
  if (!trustedProxies.contains(peerAddress)) {
    headers['x-real-ip'] = normalizeAddress(peerAddress);
    delete headers['x-forwarded-for'];
    return;
  }
  if (!headers['x-real-ip'] && !headers['x-forwarded-for']) {
    headers['x-real-ip'] = normalizeAddress(peerAddress);
  }
}
