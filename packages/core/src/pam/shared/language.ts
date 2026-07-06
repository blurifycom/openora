import { createDomainError } from '@blurifycom/core/server';
import type { PlatformConfig } from '@blurifycom/core/contracts';

export const UnsupportedLanguageError = createDomainError(
  'UnsupportedLanguageError',
  (language: string) => `${language} is not supported`,
);

export function assertSupportedLanguage(language: string, platformConfig?: PlatformConfig) {
  const supportedLanguages = platformConfig?.supportedLanguages;
  if (
    supportedLanguages &&
    supportedLanguages.length > 0 &&
    !supportedLanguages.includes(language)
  ) {
    throw new UnsupportedLanguageError(language);
  }
}
