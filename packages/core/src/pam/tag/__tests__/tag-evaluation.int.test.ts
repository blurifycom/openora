import { describe, it } from 'vitest';

describe('tag evaluation', () => {
  it.todo('an enabled rule assigns the tag when the player metric meets the threshold');
  it.todo('a disabled or missing rule is ignored without throwing');
  it.todo('an assigned non sticky tag is removed when the metric falls under the threshold');
  it.todo('a sticky tag is kept when the metric falls under the threshold');
  it.todo('a player already holding the tag gets no duplicate assignment');
  it.todo('a manual removal blocks automatic re-assignment');
  it.todo('evaluating an unknown player throws player not found');
  it.todo('a redelivered evaluation event is idempotent');
  it.todo('two concurrent evaluations of one player leave one active assignment');
  it.todo(
    'a concurrent replace of a tag set commits for one caller and fails cleanly for the other',
  );
});
