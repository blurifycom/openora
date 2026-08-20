// @2toad/profanity ships CJS only; the named import resolves via Node16 ESM/CJS interop.
import { Profanity } from '@2toad/profanity';

// Launch languages (ABC-45). @2toad/profanity ships these lists; swap to a managed
// moderation vendor later behind the same `hasProfanity` signature.
export const SUPPORTED_LANGUAGES = ['en', 'es', 'fr', 'de', 'ru', 'pt'] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

// unicodeWordBoundaries so non-Latin lists (eg the RU Cyrillic terms) match on
// word edges instead of never matching under the default ASCII boundary.
const profanity = new Profanity({
  languages: [...SUPPORTED_LANGUAGES],
  unicodeWordBoundaries: true,
});

// @2toad/profanity 3.3.0 incorrectly lists "5" as Portuguese profanity.
profanity.removeWords(['5']);

/** True when `content` contains a blocked term in any of `languages` (default: all supported). */
export function hasProfanity(content: string, languages?: readonly SupportedLanguage[]): boolean {
  return profanity.exists(content, languages ? [...languages] : undefined);
}
