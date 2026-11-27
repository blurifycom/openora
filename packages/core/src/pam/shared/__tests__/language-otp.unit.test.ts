import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { defaultPlatformConfig } from '@openora/core/contracts';
import { assertSupportedLanguage, UnsupportedLanguageError } from '../language.js';
import { generateCode, hashCode } from '../otp.js';

describe('assertSupportedLanguage', () => {
  it.each(['en', 'de', 'pt-BR', 'zh-Hant-TW'])('accepts the well formed tag %s', (tag) => {
    expect(() => assertSupportedLanguage(tag)).not.toThrow();
  });

  it.each(['', 'e n', 'en_US', '12', 'english-language-tag-too-long', 'en-'])(
    'rejects the malformed tag %j',
    (tag) => {
      expect(() => assertSupportedLanguage(tag)).toThrow(UnsupportedLanguageError);
    },
  );

  it('accepts any well formed tag when the operator lists none', () => {
    expect(() =>
      assertSupportedLanguage('fr', { ...defaultPlatformConfig, supportedLanguages: [] }),
    ).not.toThrow();
  });

  it('accepts a listed tag and rejects an unlisted one', () => {
    const config = { ...defaultPlatformConfig, supportedLanguages: ['en', 'de'] };
    expect(() => assertSupportedLanguage('de', config)).not.toThrow();
    expect(() => assertSupportedLanguage('fr', config)).toThrow(UnsupportedLanguageError);
  });

  it('rejects a malformed tag even when the list would allow it', () => {
    expect(() =>
      assertSupportedLanguage('e n', { ...defaultPlatformConfig, supportedLanguages: ['e n'] }),
    ).toThrow(UnsupportedLanguageError);
  });
});

describe('hashCode', () => {
  it('hashes to the golden sha256 hex', () => {
    expect(hashCode('123456')).toBe(
      '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92',
    );
    expect(hashCode('000000')).toBe(
      '91b4d142823f7d20c5f08df69122de43f35f057a988d9619f6d3138485c9a203',
    );
  });

  it('differs for any two different codes and matches sha256', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(hashCode(a)).toBe(createHash('sha256').update(a).digest('hex'));
        expect(a === b).toBe(hashCode(a) === hashCode(b));
      }),
    );
  });
});

describe('generateCode', () => {
  it('always yields six digits, zero padded', () => {
    for (let n = 0; n < 5_000; n++) {
      expect(generateCode()).toMatch(/^\d{6}$/);
    }
  });

  it('is not constant', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateCode()));
    expect(codes.size).toBeGreaterThan(1);
  });
});
