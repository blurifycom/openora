import { createRequire } from 'node:module';
import { DataSet, englishDataset, englishRecommendedTransformers, RegExpMatcher } from 'obscenity';

const SUPPORTED_LANGUAGES = ['en', 'es', 'fr', 'de', 'ru', 'pt'] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

type ListedLanguage = Exclude<SupportedLanguage, 'en'>;

const englishMatcher = new RegExpMatcher({
  ...new DataSet<{ originalWord: string }>()
    .addAll(englishDataset)
    .removePhrasesIf((phrase) => ['negro', 'abo'].includes(phrase.metadata?.originalWord ?? ''))
    .build(),
  ...englishRecommendedTransformers,
});

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

export function hasProfanity(
  content: string,
  languages: readonly SupportedLanguage[] = SUPPORTED_LANGUAGES,
): boolean {
  const text = normalize(content);
  return languages.some((language) =>
    language === 'en' ? englishMatcher.hasMatch(text) : listPatterns[language].test(text),
  );
}
