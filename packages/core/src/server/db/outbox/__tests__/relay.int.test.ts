import { describe, it } from 'vitest';

describe('relay', () => {
  it.todo('a row committed with the business write is published to the broker after commit');
  it.todo('a rolled back transaction publishes nothing');
  it.todo('a row is marked published only after the broker publish resolves');
  it.todo('a failing row is reported and released while the rest of the batch is published');
  it.todo('two concurrent relays never claim the same row inside its lease');
  it.todo('a row claimed by a dead relay is republished after the lease expires');
  it.todo('the same event delivered twice is processed once through the dedupe record');
  it.todo('published rows and dedupe records are pruned after their retention');
});

describe('backlog', () => {
  it.todo('the backlog reports pending rows and the age of the oldest on the database clock');
  it.todo('lag is reported only when the oldest unpublished row is older than the threshold');
  it.todo('lag is reported at most once per check interval');
  it.todo('oldestUnrelayedEvent returns nothing when everything is published');
});
