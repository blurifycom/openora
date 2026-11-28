import { BlockList, isIP } from 'node:net';

const DEFAULT_TRUSTED_PROXIES: readonly string[] = ['127.0.0.0/8', '::1/128'];

export type TrustedProxies = { contains(address: string): boolean };

export function normalizeAddress(address: string): string {
  return address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
}

export function parseTrustedProxies(entries: readonly string[]): TrustedProxies {
  const list = new BlockList();
  for (const raw of entries) {
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

function forwardedAddress(value: string): string | undefined {
  const normalized = normalizeAddress(value.trim());
  if (isIP(normalized) !== 0) {
    return normalized;
  }

  const match = /^(?:([^:[\]]+):(\d{1,5})|\[([^\]]+)\]:(\d{1,5}))$/.exec(normalized);
  const address = match?.[1] ?? match?.[3];
  const port = match?.[2] ?? match?.[4];
  if (!address || !port || Number(port) > 65_535 || isIP(address) === 0) {
    return undefined;
  }
  return normalizeAddress(address);
}

export function clientFromForwardedFor(
  forwardedFor: string,
  peerAddress: string,
  trustedProxies: TrustedProxies,
): string {
  let client = peerAddress;
  for (const hop of forwardedFor.split(',').reverse()) {
    const address = forwardedAddress(hop);
    if (!address) {
      break;
    }
    client = address;
    if (!trustedProxies.contains(address)) {
      break;
    }
  }
  return client;
}

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
  headers['x-real-ip'] = forwardedFor
    ? clientFromForwardedFor(forwardedFor, peer, trustedProxies)
    : isIP(realIp) !== 0
      ? realIp
      : peer;
}
