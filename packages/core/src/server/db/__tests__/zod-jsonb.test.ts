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

  // A shape an earlier release wrote and this one no longer accepts. One such row must cost
  // its own config, not the whole response it was selected into.
  it('reads a value the schema rejects as null', () => {
    expect(column.mapFromDriverValue({ minAmount: '1.00000000' })).toBeNull();
  });

  // A compliance column reads as absent on drift like any other, but the drift is reported
  // rather than logged: an empty risk-signal field must not look like a clean player.
  it('reports rather than warns for a column marked severity error', () => {
    const loud = pgTable('loud_probe', {
      id: uuid().primaryKey(),
      signals: zodJsonb(z.object({ vpn: z.boolean() }), 'loud_probe.signals', {
        severity: 'error',
      })(),
    });

    expect(loud.signals.mapFromDriverValue({ vpn: 'yes' })).toBeNull();
  });

  it('writes a value the schema accepts as json the driver can bind', () => {
    expect(column.mapToDriverValue({ minAmount: { USD: '1.00' } })).toBe(
      '{"minAmount":{"USD":"1.00"}}',
    );
  });

  it('refuses to write a value the schema rejects', () => {
    expect(() => column.mapToDriverValue({ minAmount: '1.00000000' })).toThrow();
  });
});
