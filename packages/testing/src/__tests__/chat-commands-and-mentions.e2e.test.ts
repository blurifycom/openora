import { describe, it } from 'vitest';

describe('chat command registry', () => {
  it.todo('a player lists only enabled commands');
  it.todo('an admin lists every command including disabled ones');
  it.todo('an admin updates a command label and limits and an audit row is written');
  it.todo('an admin updating a command with a non positive or malformed limit is rejected');
  it.todo('an admin without the chat-command permission cannot update a command');
  it.todo('an unauthenticated caller cannot list commands');
});

describe('mention search', () => {
  it.todo('a player searches by username prefix and gets matching players');
  it.todo('players the caller blocked or ignored are excluded from the results');
  it.todo('a player who blocked the caller is excluded from the results');
  it.todo('an unauthenticated caller cannot search mentions');
});
