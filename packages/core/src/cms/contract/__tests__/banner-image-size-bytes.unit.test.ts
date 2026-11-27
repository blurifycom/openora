import { describe, expect, it } from 'vitest';
import { BannerImageSizeBytesSchema } from '../index.js';

describe('BannerImageSizeBytesSchema', () => {
  it.each([0, 1000, 2_147_483_647])('accepts %j', (value) => {
    expect(BannerImageSizeBytesSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['numeric string', '1000'],
    ['above int4 max', 2_147_483_648],
  ])('rejects %s', (_name, value) => {
    expect(BannerImageSizeBytesSchema.safeParse(value).success).toBe(false);
  });
});
