import { describe, it, expect } from 'vitest';
import * as z from 'zod';
import { pgTable, uuid } from 'drizzle-orm/pg-core';
import { zodJsonb } from '../zod-jsonb.js';

const ConfigSchema = z.object({ minAmount: z.record(z.string(), z.string()).optional() });

const table = pgTable('probe', {
  id: uuid().primaryKey(),
  config: zodJsonb(ConfigSchema, 'probe.config')(),
});

const column = table.config;

describe('zodJsonb', () => {
  it('keeps the column a jsonb column', () => {
    expect(column.getSQLType()).toBe('jsonb');
  });

  it('reads a value the schema accepts', () => {
    expect(column.mapFromDriverValue({ minAmount: { USD: '1.00' } })).toEqual({
      minAmount: { USD: '1.00' },
    });
  });

  // The shape written before the value became a per-currency record. One such row must cost
  // its own config, not the whole response it was selected into.
  it('reads a value the schema rejects as null', () => {
    expect(column.mapFromDriverValue({ minAmount: '1.00000000' })).toBeNull();
  });

  it('refuses to write a value the schema rejects', () => {
    expect(() => column.mapToDriverValue({ minAmount: '1.00000000' })).toThrow();
  });
});
