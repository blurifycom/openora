import { describe, it } from 'vitest';

describe('player directory', () => {
  it.todo('an admin lists players with pagination, search and filters');
  it.todo('an admin fetches a player by id and by user id');
  it.todo('fetching an unknown player returns not found');
  it.todo('the search route matches by email, username and phone');
  it.todo('registration stats count the players registered in the window');
  it.todo('an admin without the permission is refused with forbidden');
  it.todo('a player cannot call the player directory routes');
});

describe('player update', () => {
  it.todo('an admin updates player details and the change is audited with before and after');
  it.todo('an admin cannot set an invalid country or language');
  it.todo('a player cannot update another player through the admin route');
});

describe('account managers', () => {
  it.todo('an admin assigns an account manager to a player and the assignment is listed');
  it.todo('assigning a non admin as account manager is refused');
  it.todo('clearing the account manager removes the assignment');
  it.todo('the assigned list returns only the players of that manager');
});

describe('player notes', () => {
  it.todo('an admin adds a note to a player and it is listed newest first');
  it.todo('a note with empty or oversized content is refused');
  it.todo('notes of one player are not listed for another player');
  it.todo('a note on an unknown player returns not found');
  it.todo('an admin without the permission cannot read or add notes');
  it.todo('a player cannot read the notes about themselves');
  it.todo('a note records its author and creation time and cannot be edited through the API');
});

describe('player deletion', () => {
  it.todo('an admin with the permission deletes a player and the account no longer signs in');
  it.todo('an admin without the permission is refused with forbidden');
  it.todo('deleting a player with a positive balance is refused');
});
