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
