import { hasProfanity, type SupportedLanguage } from './profanity.js';
import { sanitizeUrls } from './sanitize-urls.js';

export type ModerationResult = { ok: true; content: string } | { ok: false; reason: 'profanity' };

/** Rejects profanity and defangs dangerous URL schemes in place. */
export function moderateContent(
  content: string,
  languages?: readonly SupportedLanguage[],
): ModerationResult {
  if (hasProfanity(content, languages)) {
    return { ok: false, reason: 'profanity' };
  }
  return { ok: true, content: sanitizeUrls(content) };
}
