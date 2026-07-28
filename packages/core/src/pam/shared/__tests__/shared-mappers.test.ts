import { describe, it, expect } from 'vitest';
import { definePlatformConfig } from '@openora/core/contracts';
import { toIso } from '../date-to-iso-mapper.js';
import { nodeHeadersToHeaders } from '../headers-mapper.js';
import { assertSupportedLanguage, UnsupportedLanguageError } from '../language.js';

describe('toIso', () => {
  it('serialises a Date to an ISO string', () => {
    expect(toIso(new Date('2026-07-24T10:30:00.000Z'))).toBe('2026-07-24T10:30:00.000Z');
  });

  it('leaves an already-serialised value alone', () => {
    expect(toIso('2026-07-24T10:30:00.000Z')).toBe('2026-07-24T10:30:00.000Z');
  });

  it('normalises a non-UTC Date to UTC', () => {
    expect(toIso(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)))).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('nodeHeadersToHeaders', () => {
  it('copies a single-valued header', () => {
    expect(nodeHeadersToHeaders({ 'x-real-ip': '203.0.113.7' }).get('x-real-ip')).toBe(
      '203.0.113.7',
    );
  });

  it('joins a repeated header into one comma-separated value', () => {
    expect(nodeHeadersToHeaders({ 'set-cookie': ['a=1', 'b=2'] }).get('set-cookie')).toBe(
      'a=1, b=2',
    );
  });

  it('drops an undefined header instead of writing the string "undefined"', () => {
    expect(nodeHeadersToHeaders({ 'x-real-ip': undefined }).has('x-real-ip')).toBe(false);
  });

  it('keeps lookups case-insensitive', () => {
    expect(nodeHeadersToHeaders({ 'Content-Type': 'application/json' }).get('content-type')).toBe(
      'application/json',
    );
  });

  it('returns an empty Headers for an empty bag', () => {
    expect([...nodeHeadersToHeaders({}).keys()]).toEqual([]);
  });
});

describe('assertSupportedLanguage', () => {
  const configWith = (supportedLanguages?: string[]) =>
    definePlatformConfig(supportedLanguages ? { supportedLanguages } : {});

  it('accepts a listed language', () => {
    expect(() => assertSupportedLanguage('uk', configWith(['en', 'uk']))).not.toThrow();
  });

  it('rejects an unlisted language', () => {
    expect(() => assertSupportedLanguage('de', configWith(['en', 'uk']))).toThrow(
      UnsupportedLanguageError,
    );
  });

  it('names the rejected language in the error', () => {
    expect(() => assertSupportedLanguage('de', configWith(['en']))).toThrow(/de/);
  });

  it('accepts anything when no config is bound', () => {
    expect(() => assertSupportedLanguage('de')).not.toThrow();
  });

  it('accepts anything when the operator listed no languages', () => {
    expect(() => assertSupportedLanguage('de', configWith())).not.toThrow();
  });

  it('is case sensitive - the contract stores lowercase codes', () => {
    expect(() => assertSupportedLanguage('EN', configWith(['en']))).toThrow(
      UnsupportedLanguageError,
    );
  });
});
