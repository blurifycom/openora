import { describe, it } from 'vitest';

describe('resolveTrustedProxies', () => {
  it.todo('trusts only loopback when nothing is configured and the env var is unset');
  it.todo('an explicit configured list takes precedence over the env var');
  it.todo('an empty env var trusts no proxy at all');
  it.todo('a comma separated env list with blank entries trusts the named proxies only');
  it.todo('rejects an entry that is not an IP or CIDR');
  it.todo('rejects a CIDR with an empty suffix instead of trusting every peer');
  it.todo('rejects a prefix longer than 32 for IPv4 and 128 for IPv6');
  it.todo('rejects an entry with a second slash segment');
  it.todo('matches an IPv4 peer reported as an IPv4-mapped IPv6 address');
  it.todo('never trusts a private range that was not listed');
});

describe('applyClientAddress', () => {
  it.todo('leaves the headers alone when there is no peer address');
  it.todo(
    'overwrites x-real-ip with the socket address and drops x-forwarded-for for an untrusted peer',
  );
  it.todo('ignores a spoofed x-real-ip from an untrusted peer');
  it.todo('uses the rightmost non-proxy x-forwarded-for hop behind a trusted proxy');
  it.todo('ignores client-written hops left of the first untrusted hop');
  it.todo('walks through several trusted proxy hops to the real client');
  it.todo('stops at a malformed hop and uses the last readable one');
  it.todo('accepts a hop with a port suffix for IPv4 and bracketed IPv6');
  it.todo('rejects a hop whose port is above 65535');
  it.todo('falls back to the proxy x-real-ip when x-forwarded-for is absent and it is a valid IP');
  it.todo('falls back to the proxy socket address when x-real-ip is garbage');
  it.todo('never leaves x-real-ip empty behind a trusted proxy');
});
