import { describe, it, expect } from 'vitest';
import { MirrorUrlSchema } from '../contract/index.js';

describe('MirrorUrlSchema', () => {
  it.each(['https://mirror.example', 'https://play.mirror.example:8443'])(
    'accepts the https origin %s',
    (value) => {
      expect(MirrorUrlSchema.safeParse(value).success).toBe(true);
    },
  );

  it.each([
    ['plain http', 'http://mirror.example'],
    ['a trailing slash', 'https://mirror.example/'],
    ['a path', 'https://mirror.example/lobby'],
    ['a query string', 'https://mirror.example?next=/lobby'],
    ['embedded credentials', 'https://user:pass@mirror.example'],
    ['a non-canonical host', 'https://MIRROR.example'],
    ['a script scheme', 'javascript:alert(1)'],
    ['a bare host', 'mirror.example'],
  ])('rejects %s', (_label, value) => {
    expect(MirrorUrlSchema.safeParse(value).success).toBe(false);
  });
});
