import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { PageQuerySchema, paginated } from '../kit.js';

describe('PageQuerySchema', () => {
  it('defaults to page 1 / limit 100 when omitted', () => {
    expect(PageQuerySchema.parse({})).toEqual({ page: 1, limit: 100 });
  });

  it('coerces query-string values', () => {
    expect(PageQuerySchema.parse({ page: '2', limit: '10' })).toEqual({ page: 2, limit: 10 });
  });

  it('caps limit at 100 and floors page at 1', () => {
    expect(PageQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(PageQuerySchema.safeParse({ page: 0 }).success).toBe(false);
  });
});

describe('paginated', () => {
  it('wraps an item schema in the canonical envelope', () => {
    const schema = paginated(z.object({ id: z.string() }));
    const value = { items: [{ id: 'a' }], total: 1, page: 1, limit: 100 };
    expect(schema.parse(value)).toEqual(value);
  });

  it('rejects a non-integer total', () => {
    const schema = paginated(z.string());
    expect(schema.safeParse({ items: [], total: 1.5, page: 1, limit: 100 }).success).toBe(false);
  });
});
