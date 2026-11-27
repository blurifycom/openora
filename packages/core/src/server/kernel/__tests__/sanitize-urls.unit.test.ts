import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sanitizeUrls } from '../sanitize-urls.js';

const LIVE_SCHEME = /\b(javascript|data|vbscript|file|blob)[\t\n\r]*:/i;

describe('sanitizeUrls', () => {
  it.each([
    ['javascript:alert(1)', 'javascript alert(1)'],
    ['JaVaScRiPt:alert(1)', 'JaVaScRiPt alert(1)'],
    ['javascript :alert(1)', 'javascript alert(1)'],
    ['javascript\t\n:alert(1)', 'javascript alert(1)'],
    ['data:text/html;base64,PHNjcmlwdD4=', 'data text/html;base64,PHNjcmlwdD4='],
    ['vbscript:msgbox', 'vbscript msgbox'],
    ['file:///etc/passwd', 'file ///etc/passwd'],
    ['blob:https://x.test/uuid', 'blob https://x.test/uuid'],
    ['\u0000javascript:alert(1)', '\u0000javascript alert(1)'],
    ['click <a href="javascript:x">', 'click <a href="javascript x">'],
  ])('defangs %j', (input, expected) => {
    expect(sanitizeUrls(input)).toBe(expected);
  });

  it('defangs every occurrence in one message', () => {
    expect(sanitizeUrls('javascript:a then DATA:b then javascript:c')).toBe(
      'javascript a then DATA b then javascript c',
    );
  });

  it.each([
    'https://example.test/path?q=javascript',
    'see metadata: value',
    'myjavascript:thing',
    'plain text without schemes',
    '',
  ])('leaves %j untouched', (input) => {
    expect(sanitizeUrls(input)).toBe(input);
  });

  it('never leaves a dangerous scheme followed by a colon', () => {
    const token = fc.constantFrom(
      'javascript',
      'JavaScript',
      'data',
      'vbscript',
      'file',
      'blob',
      ':',
      ' ',
      '\t',
      '\n',
      'a',
      '/',
      '.',
    );
    fc.assert(
      fc.property(fc.array(token, { maxLength: 20 }), (tokens) => {
        expect(LIVE_SCHEME.test(sanitizeUrls(tokens.join('')))).toBe(false);
      }),
    );
  });
});
