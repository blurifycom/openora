import { describe, it } from 'vitest';

describe('system card write resolution', () => {
  it.todo('a new card key resolves to an insert');
  it.todo('a repeated card with the same key and unchanged content resolves to a no-op');
  it.todo('a card with changed content resolves to an update and keeps its original post time');
  it.todo('a card with an older post time never overwrites a newer one');
});
