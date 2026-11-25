import { describe, it } from 'vitest';

describe('Regulated actions are audited', () => {
  it.todo('a withdrawal request writes exactly one audit row with actor, action and resource');
  it.todo('a limit change writes one audit row with the before and after values');
  it.todo('a self-exclusion writes one audit row for the player actor');
  it.todo('a KYC override writes one audit row for the admin actor');
  it.todo('a refused regulated action writes no success row');
  it.todo('repeating the same request does not duplicate the audit row');
});

describe('Admin mutations', () => {
  it.todo('an admin mutation writes an audit row with an input summary');
  it.todo('the input summary omits secrets and credentials');
  it.todo('an admin read does not write a mutation row');
  it.todo('a failed admin mutation records the failure result');
});

describe('Audit log access', () => {
  it.todo('admin with the audit permission lists logs filtered by actor, action and day range');
  it.todo('admin day-range filter includes the whole start and end days in UTC');
  it.todo('admin exports the filtered logs as csv and the csv matches the list');
  it.todo('export refuses an inverted day range');
  it.todo('player cannot list or export audit logs');
  it.todo('player reads only own responsible-gambling history ordered by sort direction');
  it.todo('player cannot read another player history through the route');
  it.todo('rows still waiting in the outbox appear in reads before the shipper drains');
});
