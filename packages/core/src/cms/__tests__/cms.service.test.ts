import { describe, it, expect } from 'vitest';
import { PageNotFoundError, BannerNotFoundError } from '../service/cms.service.js';

describe('CmsService domain errors', () => {
  it('PageNotFoundError carries the identifier', () => {
    const err = new PageNotFoundError('my-slug');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PageNotFoundError');
    expect(err.message).toContain('my-slug');
  });

  it('BannerNotFoundError carries the id', () => {
    const err = new BannerNotFoundError('banner-123');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('BannerNotFoundError');
    expect(err.message).toContain('banner-123');
  });
});
