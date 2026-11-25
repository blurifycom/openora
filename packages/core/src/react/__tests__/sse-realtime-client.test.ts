import { describe, it } from 'vitest';

describe('sse realtime client', () => {
  it.todo('reports connecting then open on every reconnect');
  it.todo('reconnects with exponential backoff after a dropped stream');
  it.todo('a 4xx error other than 408 and 429 stops the channel until the next subscribe');
  it.todo('a 408 or 429 error reconnects');
  it.todo('the access revoked signal closes the channel without reconnecting');
  it.todo('the last unsubscribe closes the stream after the grace delay');
  it.todo('a resubscribe within the grace delay keeps the stream open');
  it.todo('refresh reopens a stopped channel');
});
