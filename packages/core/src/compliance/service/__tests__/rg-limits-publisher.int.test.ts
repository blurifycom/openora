import { describe, it } from 'vitest';

describe('limit projection snapshot', () => {
  it.todo('publishing for a new user writes version 1 and a snapshot of every limit');
  it.todo('publishing again bumps the version by one');
  it.todo(
    'a row that fails the snapshot contract is projected as a zero-amount limit that refuses every move',
  );
  it.todo(
    'the snapshot is written to the limit ledger in the caller transaction and rolls back with it',
  );
  it.todo('the changed event is emitted in the same transaction as the snapshot');
  it.todo(
    'concurrent publishes for one user serialize and read the limits after the previous commit',
  );
  it.todo('backfill repairs users whose snapshot is missing or stale and skips current ones');
  it.todo('backfill with a changed-since date only visits users with a limit updated since then');
  it.todo('backfill stops when its abort signal fires');
});
