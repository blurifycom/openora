import { describe, it } from 'vitest';

describe('player notifications', () => {
  it.todo('a player lists only their own notifications newest first');
  it.todo('unread count drops to zero after read-all and another player count is unchanged');
  it.todo('read-all twice is idempotent');
  it.todo('an unauthenticated caller cannot list, count or read all notifications');
  it.todo('a notification disabled by the player preferences is not created');
  it.todo('a notification queued twice with the same key is delivered once');
  it.todo('a notification arrives on the player stream and not on another player stream');
});
