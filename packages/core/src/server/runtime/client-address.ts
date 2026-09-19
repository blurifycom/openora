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
    // Anchored so an empty suffix (`10.0.0.1/`) cannot slip through as `Number('') === 0` - a
    // /0 that would trust every peer - and neither can a second `/…` segment.
    const match = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(raw.trim());
    const address = match?.[1] ?? '';
    const family = isIP(address);
    const prefix = match?.[2] === undefined ? undefined : Number(match[2]);
    if (family === 0 || (prefix !== undefined && prefix > (family === 4 ? 32 : 128))) {
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

// Walks X-Forwarded-For from the right - each hop appends the address it saw - and stops at
// the first entry that is not itself a trusted proxy: that is the client. Anything left of it
// was written by the client and is ignored. A malformed entry ends the walk at the last hop
// that could still be read, so garbage never becomes the address.
function clientFromForwardedFor(
  forwardedFor: string,
  peerAddress: string,
  trustedProxies: TrustedProxies,
): string {
  let client = peerAddress;
  for (const hop of forwardedFor.split(',').reverse()) {
    const address = normalizeAddress(hop.trim());
    if (isIP(address) === 0) {
      break;
    }
    client = address;
    if (!trustedProxies.contains(address)) {
      break;
    }
  }
  return client;
}

// The one place a request's client address is decided. Every per-IP throttle, geo check and
// audit row downstream reads `X-Real-IP` (and `X-Forwarded-For` behind `trustForwarded`), so
// those headers are only honoured when the peer that sent them is a trusted proxy. Any other
// peer gets its socket address written over `X-Real-IP` and its `X-Forwarded-For` dropped -
// rotating either header then buys a direct caller nothing.
//
// Behind a trusted proxy, `X-Real-IP` always ends up holding a valid address: the proxy's own
// `X-Real-IP` if it set a usable one, else the client derived from `X-Forwarded-For` (an
// XFF-only balancer such as AWS ALB), else the proxy's socket address. It is never left empty,
// so no request falls into a shared `unknown` bucket that one caller could exhaust for all.
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
  const peer = normalizeAddress(peerAddress);
  if (!trustedProxies.contains(peer)) {
    headers['x-real-ip'] = peer;
    delete headers['x-forwarded-for'];
    return;
  }
  const realIp = normalizeAddress(headers['x-real-ip']?.trim() ?? '');
  const forwardedFor = headers['x-forwarded-for'];
  headers['x-real-ip'] =
    isIP(realIp) !== 0
      ? realIp
      : forwardedFor
        ? clientFromForwardedFor(forwardedFor, peer, trustedProxies)
        : peer;
}
