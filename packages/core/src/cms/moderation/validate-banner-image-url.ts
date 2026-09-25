import { isAllowedHost } from '@openora/core/contracts';

export type BannerImageUrlValidationResult = { ok: true } | { ok: false; reason: string };

export function validateBannerImageUrl(
  url: string,
  allowedHosts: readonly string[],
): BannerImageUrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `invalid URL: ${url}` };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: `unsupported protocol: ${parsed.protocol}` };
  }
  if (!isAllowedHost(parsed.hostname, allowedHosts)) {
    return { ok: false, reason: `host not allowed: ${parsed.hostname}` };
  }
  return { ok: true };
}
