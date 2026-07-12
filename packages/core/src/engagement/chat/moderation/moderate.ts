import { hasProfanity, type SupportedLanguage } from './profanity.js';
import { sanitizeUrls } from './sanitize-urls.js';

export type ModerationResult = { ok: true; content: string } | { ok: false; reason: 'profanity' };

/**
 * Runs a message through the publish-time content gate: profanity is rejected
 * (so it never reaches other players), dangerous URLs are defanged in-place.
 */
export function moderateContent(
  content: string,
  languages?: readonly SupportedLanguage[],
): ModerationResult {
  if (hasProfanity(content, languages)) {
    return { ok: false, reason: 'profanity' };
  }
  return { ok: true, content: sanitizeUrls(content) };
}
