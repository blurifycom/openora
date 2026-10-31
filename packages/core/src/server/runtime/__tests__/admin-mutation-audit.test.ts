import { describe, it, expect } from 'vitest';
import { inputSummary } from '../admin-mutation-audit.js';

describe('inputSummary', () => {
  it('keeps the field names and a hash, never a value', () => {
    const summary = inputSummary({ operatorKey: 'hunter2', id: 'a' });

    expect(summary.inputKeys).toEqual(['id', 'operatorKey']);
    expect(JSON.stringify(summary)).not.toContain('hunter2');
  });

  it('hashes equal inputs alike whatever their key order, and different ones apart', () => {
    expect(inputSummary({ a: 1, b: 2 }).inputHash).toBe(inputSummary({ b: 2, a: 1 }).inputHash);
    expect(inputSummary({ a: 1 }).inputHash).not.toBe(inputSummary({ a: 2 }).inputHash);
  });

  it('has no keys for an input that is not an object', () => {
    expect(inputSummary(undefined).inputKeys).toEqual([]);
    expect(inputSummary('text').inputKeys).toEqual([]);
  });
});
