import { describe, expect, it } from 'vitest';
import { withInactive } from '../gaming.service.js';

describe('withInactive', () => {
  it.each([
    [10, 4, 6],
    [0, 0, 0],
    [5, 5, 0],
    [5, 0, 5],
  ])('total %i with %i active has %i inactive', (total, active, inactive) => {
    expect(withInactive({ total, active })).toEqual({ total, active, inactive });
  });

  it('keeps extra fields', () => {
    expect(withInactive({ total: 3, active: 1, pending: 2 })).toEqual({
      total: 3,
      active: 1,
      pending: 2,
      inactive: 2,
    });
  });
});
