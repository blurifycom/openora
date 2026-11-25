import { describe, it } from 'vitest';

describe('chat transfer check', () => {
  it.todo('a disabled command is refused');
  it.todo('an actor banned from the room is refused');
  it.todo('a counterpart blocked by the actor or blocking the actor is reported');
  it.todo('counterparts above the cap are refused');
  it.todo('a concurrent block waits for the transfer transaction to commit');
  it.todo('an unanswered remote check refuses as unavailable');
  it.todo('a caller service outside the allowed list is refused on the internal route');
});
