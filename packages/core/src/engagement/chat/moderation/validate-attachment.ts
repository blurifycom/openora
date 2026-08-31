import type { ChatAttachment } from '@openora/core/contracts';

export type AttachmentValidationResult = { ok: true } | { ok: false; reason: string };

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
