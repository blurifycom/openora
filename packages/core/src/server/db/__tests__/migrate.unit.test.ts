import { describe, expect, it } from 'vitest';
import { appendOnlyTableSql } from '../migrate.js';

describe('appendOnlyTableSql', () => {
  it.each([
    ['a quote in the table', "ledger'; DROP TABLE wallet; --", { mutableColumns: [] }],
    ['a double quote in the table', 'ledger"x', { mutableColumns: [] }],
    ['an upper case table', 'Ledger', { mutableColumns: [] }],
    ['a schema qualified table', 'public.ledger', { mutableColumns: [] }],
    ['a table starting with a digit', '1ledger', { mutableColumns: [] }],
    ['an empty table', '', { mutableColumns: [] }],
    ['a trailing newline', 'ledger\n', { mutableColumns: [] }],
    ['a dollar quote in a column', 'ledger', { mutableColumns: ['note$$'] }],
    ['a space in a set-once column', 'ledger', { mutableColumns: [], setOnceColumns: ['a b'] }],
    [
      'a quote in a terminal value',
      'ledger',
      { mutableColumns: [], terminal: { column: 'status', values: ["settled'"] } },
    ],
    [
      'a bad terminal column',
      'ledger',
      { mutableColumns: [], terminal: { column: 'Status', values: ['settled'] } },
    ],
    [
      'a bad grow-only column',
      'ledger',
      {
        mutableColumns: [],
        terminal: { column: 'status', values: ['settled'], growOnly: ['a;b'] },
      },
    ],
    [
      'a bad grow-only total column',
      'ledger',
      {
        mutableColumns: [],
        terminal: { column: 'status', values: ['settled'], growOnlyTotals: [['paid', 'x-y']] },
      },
    ],
  ])('refuses %s', (_name, table, options) => {
    expect(() => appendOnlyTableSql(table, options)).toThrow(/Invalid SQL identifier/);
  });

  it('exempts only the mutable and set-once columns from the update guard', () => {
    const sql = appendOnlyTableSql('ledger', {
      mutableColumns: ['status'],
      setOnceColumns: ['settled_at'],
    });
    expect(sql).toContain("ARRAY['status', 'settled_at']::text[]");
    expect(sql).toContain(
      'IF OLD.settled_at IS NOT NULL AND NEW.settled_at IS DISTINCT FROM OLD.settled_at THEN',
    );
    expect(sql).not.toContain('OLD.status IS NOT NULL');
  });

  it('denies DELETE per statement and guards UPDATE per row', () => {
    const sql = appendOnlyTableSql('ledger', { mutableColumns: [] });
    expect(sql).toContain(
      'CREATE TRIGGER ledger_append_only_delete BEFORE DELETE ON ledger FOR EACH STATEMENT EXECUTE FUNCTION ledger_deny_delete();',
    );
    expect(sql).toContain(
      'CREATE TRIGGER ledger_append_only_update BEFORE UPDATE ON ledger FOR EACH ROW EXECUTE FUNCTION ledger_guard_update();',
    );
    expect(sql).not.toMatch(/TRUNCATE/);
  });

  it('creates each trigger only when missing so a rerun takes no lock', () => {
    const sql = appendOnlyTableSql('ledger', { mutableColumns: [] });
    expect(sql).toContain(
      "IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'ledger'::regclass AND tgname = 'ledger_append_only_update')",
    );
  });

  it('freezes a terminal row and keeps its grow-only columns and totals from falling', () => {
    const sql = appendOnlyTableSql('payout', {
      mutableColumns: ['status', 'paid', 'refunded'],
      terminal: {
        column: 'status',
        values: ['settled', 'void'],
        growOnly: ['paid'],
        growOnlyTotals: [['paid', 'refunded']],
      },
    });
    expect(sql).toContain("IF OLD.status::text = ANY(ARRAY['settled', 'void']) THEN");
    expect(sql).toContain('IF NEW.status IS DISTINCT FROM OLD.status THEN');
    expect(sql).toContain('IF NEW.paid < OLD.paid THEN');
    expect(sql).toContain('IF NEW.refunded < 0 THEN');
    expect(sql).toContain('IF NEW.paid + NEW.refunded < OLD.paid + OLD.refunded THEN');
  });

  it('is deterministic for the same input', () => {
    const options = { mutableColumns: ['status'], setOnceColumns: ['settled_at'] };
    expect(appendOnlyTableSql('ledger', options)).toBe(appendOnlyTableSql('ledger', options));
  });
});
