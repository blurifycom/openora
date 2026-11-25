import { describe, it } from 'vitest';

describe('support chat session and tickets', () => {
  it.todo('a signed in player opens a support session and gets a customer token');
  it.todo(
    'opening a session syncs the customer context and a later profile change is synced until the chat is settled',
  );
  it.todo('a player creates a ticket and the provider receives the customer context');
  it.todo('an unauthenticated caller cannot open a session or create a ticket');
  it.todo('a provider failure returns a generic refusal and no adapter data reaches the player');
  it.todo('a ticket created twice with the same key does not create a duplicate at the provider');
});

describe('support history by email', () => {
  it.todo(
    'a player lists support history including items filed under a previous email within its window',
  );
  it.todo('an item filed under an email the player never held is not returned');
  it.todo('history is not configured returns the not configured refusal');
  it.todo('a player cannot read another player support history');
});
