import { describe, it } from 'vitest';

describe('outbox shipping', () => {
  it.todo('enqueued entries are shipped into the chain in enqueue order');
  it.todo('draining twice ships each entry once');
  it.todo('an entry with an event id already shipped is skipped');
  it.todo('a malformed outbox entry is rejected without blocking the rest of the batch');
  it.todo('the backlog count and oldest age reflect undrained rows');
  it.todo('unshipped outbox rows cannot be deleted');
  it.todo('two drainers running together never produce a duplicate or a gap');
});

describe('separate audit store', () => {
  it.todo(
    'with the chain on a separate database, shipping writes the chain there and marks the outbox shipped on the main database',
  );
  it.todo('shipping refuses when the chain store was restored behind the outbox');
  it.todo('copy to a separate audit store copies every row and the copied chain verifies');
  it.todo('copy run twice does not duplicate rows');
  it.todo('copy refuses a target that is the same database as the source');
  it.todo('after the split the main database stops accepting chain rows');
});
