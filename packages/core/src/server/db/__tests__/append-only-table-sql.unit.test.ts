import { describe, expect, it } from 'vitest';
import { appendOnlyTableSql } from '../migrate.js';

describe('appendOnlyTableSql transitions', () => {
  it('refuses a transition on a column the whole-row check would freeze', () => {
    expect(() =>
      appendOnlyTableSql('ledger', {
        mutableColumns: ['status'],
        transitions: [{ column: 'stage', allowed: [['open', 'closed']] }],
      }),
    ).toThrow(/stage/);
  });
});
