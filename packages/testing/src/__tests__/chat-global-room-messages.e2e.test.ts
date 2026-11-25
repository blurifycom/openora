import { describe, it } from 'vitest';

describe('player posts to the global chat', () => {
  it.todo('a player posts a message and it appears in the global history for another player');
  it.todo(
    'a message containing an @mention of an existing player is stored with the mention resolved',
  );
  it.todo('an unauthenticated caller cannot post or read the global chat');
  it.todo('a muted player is refused and no message row is written');
  it.todo('a banned player is refused posting and reading');
  it.todo('a player in cooldown is refused until the cooldown is lifted');
  it.todo('a message over the length limit or with an invalid attachment is rejected');
  it.todo('a message from a player blocked by the reader is excluded from the reader history');
});

describe('private rooms and invites', () => {
  it.todo(
    'a player creates a private room and invites another player who joins through the invite',
  );
  it.todo('a player who was not invited cannot join the private room or read its messages');
  it.todo('an expired invite cannot be used to join');
  it.todo('a room ban stops the banned player posting in that room only');
  it.todo('a room moderator lists moderated rooms and a regular member gets none');
});

describe('player blocks and ignores', () => {
  it.todo(
    'a player blocks another player and the blocked player messages disappear from the blocker history',
  );
  it.todo('blocking the same player twice does not create a duplicate row');
  it.todo('a player cannot list another player blocks');
});

describe('chat moderation in the backoffice', () => {
  it.todo('an admin with the chat permission mutes a player, lists the mute and lifts it');
  it.todo(
    'an admin without the chat permission is refused every moderation route and no row is written',
  );
  it.todo('an admin ban writes an audit row and lifting it restores posting');
  it.todo('an admin cooldown is applied and lifted and the player posting follows it');
  it.todo('an admin lists messages filtered by player and by room');
});
