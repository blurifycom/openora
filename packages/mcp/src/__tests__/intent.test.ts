import { describe, expect, it } from 'vitest';
import { classifyIntent } from '../intent.js';

describe('classifyIntent', () => {
  it.each([
    ['add a stripe gateway', 'adapter'],
    ['build a player page', 'ui-page'],
    ['add an rpc endpoint', 'route'],
    ['weekly cashback', 'feature'],
    ['make it nicer', 'unsure'],
    ['', 'unsure'],
    ['ADD KYC', 'adapter'],
    ['payment page', 'adapter'],
    ['bonus page', 'ui-page'],
    ['dashboard route', 'ui-page'],
    ['bonus route', 'route'],
    ['payments', 'unsure'],
  ] as const)('%s -> %s', (ask, kind) => {
    expect(classifyIntent(ask)).toBe(kind);
  });
});
