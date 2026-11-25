import { describe, it } from 'vitest';

describe('friend requests', () => {
  it.todo('a player sends a friend request and the target sees it as incoming');
  it.todo('the target accepts and both players list each other as friends');
  it.todo('the target declines and neither player is listed as a friend');
  it.todo('the sender cancels a pending request and it disappears for the target');
  it.todo('a player cannot send a request to themselves');
  it.todo('a repeated request to the same player does not create a second pending row');
  it.todo('a player cannot accept or decline a request addressed to someone else');
  it.todo('a request to a player who blocked the sender is refused');
  it.todo('an unauthenticated caller cannot send or list requests');
});

describe('relationships and privacy', () => {
  it.todo(
    'relationships between the caller and a list of players report friend, pending in, pending out and none',
  );
  it.todo('a player who turned off friend requests in privacy settings cannot be sent a request');
  it.todo('removing a friend removes the friendship for both players');
  it.todo('blocking a friend dissolves the friendship');
});
