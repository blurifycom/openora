import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { originVerdict, parseBearer, servesHost } from '../transport-gate.js';

const TOKEN = 'ora_mcp_abcDEF123-_';

describe('parseBearer', () => {
  it('returns the token of a well formed header', () => {
    expect(parseBearer(`Bearer ${TOKEN}`)).toBe(TOKEN);
  });

  it.each(['Bearer', 'BEARER', 'bearer', 'bEaReR'])('accepts the scheme spelled %s', (scheme) => {
    expect(parseBearer(`${scheme} ${TOKEN}`)).toBe(TOKEN);
  });

  it('accepts several spaces between scheme and token', () => {
    expect(parseBearer(`Bearer     ${TOKEN}`)).toBe(TOKEN);
  });

  it('keeps trailing padding of the token', () => {
    expect(parseBearer('Bearer abc==')).toBe('abc==');
  });

  it.each([
    ['null', null],
    ['empty', ''],
    ['scheme only', 'Bearer '],
    ['no space', `Bearer${TOKEN}`],
    ['other scheme', `Basic ${TOKEN}`],
    ['leading space', ` Bearer ${TOKEN}`],
    ['trailing space', `Bearer ${TOKEN} `],
    ['trailing newline', `Bearer ${TOKEN}\n`],
    ['tab separator', `Bearer\t${TOKEN}`],
    ['two tokens', `Bearer ${TOKEN} extra`],
    ['comma list', `Bearer ${TOKEN},Bearer other`],
    ['non token character', 'Bearer abc$def'],
    ['padding in the middle', 'Bearer ab=cd'],
    ['unicode', 'Bearer tökén'],
    ['bare token', TOKEN],
  ])('rejects %s', (_name, header) => {
    expect(parseBearer(header)).toBeNull();
  });

  it('accepts a header of exactly 512 characters', () => {
    const header = `Bearer ${'a'.repeat(512 - 'Bearer '.length)}`;
    expect(header).toHaveLength(512);
    expect(parseBearer(header)).toBe('a'.repeat(505));
  });

  it('rejects a header of 513 characters', () => {
    const header = `Bearer ${'a'.repeat(513 - 'Bearer '.length)}`;
    expect(header).toHaveLength(513);
    expect(parseBearer(header)).toBeNull();
  });

  it('rejects a very long run of spaces without hanging', () => {
    expect(parseBearer(`Bearer ${' '.repeat(100_000)}x`)).toBeNull();
  });

  it('never returns a token containing a space or newline', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 600 }), (header) => {
        const token = parseBearer(header);
        expect(token === null || /^[\w\-.~+/]+=*$/.test(token)).toBe(true);
      }),
    );
  });
});

describe('originVerdict', () => {
  const allowed = ['https://admin.example.com', 'https://app.example.com'];

  it('reports none when the request has no Origin', () => {
    expect(originVerdict(null, allowed)).toBe('none');
  });

  it('reports none for a missing Origin even with an empty allow list', () => {
    expect(originVerdict(null, [])).toBe('none');
  });

  it('allows a listed origin', () => {
    expect(originVerdict('https://admin.example.com', allowed)).toBe('allowed');
  });

  it('refuses every origin when the allow list is empty', () => {
    expect(originVerdict('https://admin.example.com', [])).toBe('refused');
  });

  it('refuses the literal null origin when it is not listed', () => {
    expect(originVerdict('null', allowed)).toBe('refused');
  });

  it('refuses an empty Origin header value', () => {
    expect(originVerdict('', allowed)).toBe('refused');
  });

  it.each([
    'https://admin.example.com/',
    'http://admin.example.com',
    'https://admin.example.com:443',
    'https://ADMIN.example.com',
    'https://admin.example.com.evil.test',
    'https://evil.test',
    'https://sub.admin.example.com',
    '*',
  ])('refuses %j, which is not an exact match', (origin) => {
    expect(originVerdict(origin, allowed)).toBe('refused');
  });
});

describe('servesHost', () => {
  const hosts = ['api.example.com', 'localhost'];

  it.each([
    ['api.example.com', true],
    ['API.EXAMPLE.COM', true],
    ['localhost', true],
    ['evil.test', false],
    ['api.example.com.evil.test', false],
    ['', false],
  ])('%j is %s', (host, expected) => {
    expect(servesHost(host, hosts)).toBe(expected);
  });

  it('refuses every host for an empty list', () => {
    expect(servesHost('api.example.com', [])).toBe(false);
  });
});
