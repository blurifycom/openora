import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { PageQuerySchema, QueryBooleanSchema, createKebabSlugSchema, paginated } from '../kit.js';

describe('PageQuerySchema', () => {
  it('defaults to page 1 / limit 100 when omitted', () => {
    expect(PageQuerySchema.parse({})).toEqual({ page: 1, limit: 100 });
  });

  it('coerces query-string values', () => {
    expect(PageQuerySchema.parse({ page: '2', limit: '10' })).toEqual({ page: 2, limit: 10 });
  });

  it('caps limit at 100 and floors page at 1', () => {
    expect(PageQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
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

describe('QueryBooleanSchema', () => {
  it("coerces 'true'/'false' query strings to booleans", () => {
    expect(QueryBooleanSchema.parse('true')).toBe(true);
    expect(QueryBooleanSchema.parse('false')).toBe(false);
    expect(QueryBooleanSchema.parse(true)).toBe(true);
  });
});

describe('createKebabSlugSchema', () => {
  it('accepts kebab-case and rejects leading/trailing hyphens', () => {
    const schema = createKebabSlugSchema(64);
    expect(schema.parse('pragmatic-play')).toBe('pragmatic-play');
    expect(schema.safeParse('-bad').success).toBe(false);
    expect(schema.safeParse('bad-').success).toBe(false);
    expect(schema.safeParse('Bad_Slug').success).toBe(false);
  });

  it('enforces the max length', () => {
    const schema = createKebabSlugSchema(4);
    expect(schema.safeParse('abcde').success).toBe(false);
  });
});
