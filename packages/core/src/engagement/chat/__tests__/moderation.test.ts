import { describe, it, expect } from 'vitest';
import { hasProfanity, sanitizeUrls, moderateContent } from '../moderation/index.js';

describe('hasProfanity', () => {
  it('flags blocked words across every launch language', () => {
    expect(hasProfanity('you are a fuck')).toBe(true); // en
    expect(hasProfanity('eres una mierda')).toBe(true); // es
    expect(hasProfanity('quel connard')).toBe(true); // fr
    expect(hasProfanity('du arschloch')).toBe(true); // de
    expect(hasProfanity('ты мудак')).toBe(true); // ru (Cyrillic)
    expect(hasProfanity('vai à merda')).toBe(true); // pt
  });

  it('matches case-insensitively and on word boundaries only', () => {
    expect(hasProfanity('SHIT happens')).toBe(true);
    expect(hasProfanity('classic match')).toBe(false); // no substring hit inside "classic"
  });

  it('returns false for clean content', () => {
    expect(hasProfanity('good luck everyone, nice game')).toBe(false);
  });

  it('can scope to a subset of languages', () => {
    expect(hasProfanity('mierda', ['en'])).toBe(false);
    expect(hasProfanity('mierda', ['es'])).toBe(true);
  });
});

describe('sanitizeUrls', () => {
  it('defangs dangerous schemes so they cannot become clickable', () => {
    expect(sanitizeUrls('click javascript:alert(1)')).toBe('click javascript alert(1)');
    expect(sanitizeUrls('DATA:text/html,x')).toBe('DATA text/html,x');
  });

  it('defangs even with whitespace browsers ignore before the colon', () => {
    expect(sanitizeUrls('x javascript :y')).toBe('x javascript y');
    expect(sanitizeUrls('x vbscript\t:y')).toBe('x vbscript y');
  });

  it('leaves safe http(s) links untouched', () => {
    const safe = 'see https://example.com/path?q=1';
    expect(sanitizeUrls(safe)).toBe(safe);
  });
});

describe('moderateContent', () => {
  it('blocks profane messages with a reason', () => {
    expect(moderateContent('this is shit')).toEqual({ ok: false, reason: 'profanity' });
  });

  it('passes clean content through with URLs sanitized', () => {
    expect(moderateContent('hi javascript:void(0)')).toEqual({
      ok: true,
      content: 'hi javascript void(0)',
    });
  });

  it('preserves emoji (AC6)', () => {
    const withEmoji = 'gg 🎉🔥 nice 😄';
    expect(moderateContent(withEmoji)).toEqual({ ok: true, content: withEmoji });
  });
});
