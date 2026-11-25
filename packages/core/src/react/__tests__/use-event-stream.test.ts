import { describe, it } from 'vitest';

describe('useEventStream', () => {
  it.todo('stays idle and opens no stream when disabled');
  it.todo('moves from connecting to open on the first event and delivers events to onEvent');
  it.todo('reconnects with exponential backoff capped at the max delay after an unexpected close');
  it.todo('resets the backoff only after a connection has stayed open');
  it.todo('does not reconnect after an intentional teardown');
  it.todo('aborts the stream and clears the retry timer on unmount');
});
