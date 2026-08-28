import type { ChatAttachment } from '@openora/core/contracts';

export type AttachmentValidationResult = { ok: true } | { ok: false; reason: string };

// A host is allowed if it matches an allow-list entry exactly or is a subdomain of one,
// so an operator can allow-list `example.com` once and cover `cdn.example.com` too.
function isAllowedHost(hostname: string, allowedHosts: readonly string[]): boolean {
  return allowedHosts.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`));
}

function validateUrl(raw: string, allowedHosts: readonly string[]): AttachmentValidationResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `invalid URL: ${raw}` };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: `unsupported protocol: ${url.protocol}` };
  }
  if (!isAllowedHost(url.hostname, allowedHosts)) {
    return { ok: false, reason: `host not allowed: ${url.hostname}` };
  }
  return { ok: true };
}

/**
 * Validates a chat attachment's `url` and `previewUrl` against an operator-configured
 * host allow-list. Pure: the allow-list is passed in, never read from global config.
 * Both URLs must be `https:` and resolve to an allowed host (exact match or subdomain).
 *
 * This is intentionally separate from `moderateContent`/`sanitizeUrls`, which defang
 * freeform user text and are not meant to validate a trusted attachment shape's URLs.
 */
export function validateAttachment(
  attachment: Pick<ChatAttachment, 'url' | 'previewUrl'>,
  allowedHosts: readonly string[],
): AttachmentValidationResult {
  const urlResult = validateUrl(attachment.url, allowedHosts);
  if (!urlResult.ok) {
    return urlResult;
  }
  return validateUrl(attachment.previewUrl, allowedHosts);
}
