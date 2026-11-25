import { describe, it } from 'vitest';

describe('publish and consume', () => {
  it.todo('a published event reaches every consumer group once');
  it.todo('every local handler runs even when a sibling handler throws');
  it.todo('an entry is acknowledged after handlers succeed');
});

describe('retry and dead-letter', () => {
  it.todo(
    'a failing entry is retried until the max delivery count then moved to the dead-letter stream',
  );
  it.todo('a dead-lettered entry keeps its payload, error and delivery count');
  it.todo('an idle pending entry is reclaimed by another consumer');
  it.todo('an entry pending past the retention window is dead-lettered without a handler run');
  it.todo('the dead-letter stream is never trimmed');
  it.todo('deadLetters reports the count per stream');
});

describe('startup', () => {
  it.todo('creating a consumer group that already exists does not fail');
  it.todo('a stream loop error is logged and the loop continues');
});
