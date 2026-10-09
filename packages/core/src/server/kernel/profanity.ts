import { createRequire } from 'node:module';
import { DataSet, englishDataset, englishRecommendedTransformers, RegExpMatcher } from 'obscenity';

export const SUPPORTED_LANGUAGES = ['en', 'es', 'fr', 'de', 'ru', 'pt'] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

type ListedLanguage = Exclude<SupportedLanguage, 'en'>;

// English goes through obscenity: it resolves leetspeak, repeated letters and look-alike
// characters, and whitelists innocent words that contain a blocked one ("assassin"). Two of
// its words are everyday words in a supported language: es/pt "negro" and de "Abo".
const englishMatcher = new RegExpMatcher({
  ...new DataSet<{ originalWord: string }>()
    .addAll(englishDataset)
    .removePhrasesIf((phrase) => ['negro', 'abo'].includes(phrase.metadata?.originalWord ?? ''))
    .build(),
  ...englishRecommendedTransformers,
});

// The other languages use the LDNOOBW lists (naughty-words, CC-BY-4.0), plus the common
// Russian obscenities the list lacks.
const MISSING: Partial<Record<ListedLanguage, readonly string[]>> = {
  ru: ['бля', 'блять', 'долбоёб', 'мудак', 'пидор', 'пиздец', 'сука', 'хуйня'],
};

const nodeRequire = createRequire(import.meta.url);

function normalize(text: string) {
  return text.normalize('NFC').toLowerCase();
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One whole-word pattern per language; letters and digits are word characters in any script. */
function buildListPattern(language: ListedLanguage) {
  const listed = nodeRequire(`naughty-words/${language}.json`) as string[];
  const terms = [...listed, ...(MISSING[language] ?? [])].map(normalize);
  const alternation = terms.map((term) => escapeRegExp(term).replace(/\s+/g, '\\s+')).join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation})(?![\\p{L}\\p{N}])`, 'u');
}

const listPatterns: Record<ListedLanguage, RegExp> = {
  es: buildListPattern('es'),
  fr: buildListPattern('fr'),
  de: buildListPattern('de'),
  ru: buildListPattern('ru'),
  pt: buildListPattern('pt'),
};

/** True when `content` contains a blocked term in any of `languages` (default: all supported). */
export function hasProfanity(
  content: string,
  languages: readonly SupportedLanguage[] = SUPPORTED_LANGUAGES,
): boolean {
  const text = normalize(content);
  return languages.some((language) =>
    language === 'en' ? englishMatcher.hasMatch(text) : listPatterns[language].test(text),
  );
}
