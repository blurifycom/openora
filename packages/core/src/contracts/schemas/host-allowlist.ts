import * as z from 'zod';

export const HostAllowlistEntrySchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (hostname) => {
      try {
        const url = new URL(`https://${hostname}`);
        return (
          url.hostname === hostname.toLowerCase() &&
          url.pathname === '/' &&
          url.port === '' &&
          url.username === '' &&
          url.password === '' &&
          url.search === '' &&
          url.hash === ''
        );
      } catch {
        return false;
      }
    },
    { message: 'must be a hostname without a protocol, port, credentials, or path' },
  )
  .transform((hostname) => hostname.toLowerCase());

export function isAllowedHost(hostname: string, allowedHosts: readonly string[]): boolean {
  return allowedHosts.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`));
}

export function isAllowedHttpsUrl(url: string, allowedHosts: readonly string[]): boolean {
  const parsed = URL.parse(url);
  return (
    parsed?.protocol === 'https:' &&
    parsed.port === '' &&
    isAllowedHost(parsed.hostname, allowedHosts)
  );
}

const QUERY_OR_FRAGMENT = /[?#]/;
const ENCODED_SEPARATOR = /%2f|%5c/i;

function isBareHttpUrl(url: URL): boolean {
  return (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.username === '' &&
    url.password === '' &&
    !QUERY_OR_FRAGMENT.test(url.href)
  );
}

export const UrlPrefixAllowlistEntrySchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => {
      const url = URL.parse(value);
      return url !== null && isBareHttpUrl(url) && url.pathname.endsWith('/');
    },
    {
      message: 'must be an absolute http(s) URL ending in "/" without credentials, query, or hash',
    },
  )
  .transform((value) => new URL(value).href);

export function isAllowedUrlPrefix(url: string, allowedPrefixes: readonly string[]): boolean {
  const parsed = URL.parse(url);
  if (!parsed || !isBareHttpUrl(parsed)) {
    return false;
  }
  return allowedPrefixes.some((prefix) => {
    const allowed = URL.parse(prefix);
    return (
      allowed !== null &&
      parsed.origin === allowed.origin &&
      parsed.pathname.startsWith(allowed.pathname) &&
      !ENCODED_SEPARATOR.test(parsed.pathname.slice(allowed.pathname.length))
    );
  });
}
