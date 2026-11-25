import { describe, it } from 'vitest';

describe('append-only hash chain', () => {
  it.todo('the first row has sequence 1 and an empty previous hash');
  it.todo('each next row stores the previous row hash and the next sequence');
  it.todo('concurrent appends produce a gap-free sequence with an unbroken chain');
  it.todo('verifying an untouched chain reports ok');
  it.todo('verifying a chain whose row content was edited reports the first broken sequence');
  it.todo('verifying a chain whose row was deleted reports the break');
  it.todo('verifying a chain whose hash was rewritten reports a mismatch with the next row');
  it.todo('updating or deleting an audit row is refused by the database');
  it.todo('a row written with jsonb keys in a different order still verifies');
  it.todo('a rejected entry in a batch does not break the chain of the accepted ones');
  it.todo('an audited write rolls back with its business transaction and leaves no row');
});
