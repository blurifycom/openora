import { describe, it } from 'vitest';

describe('replicas', () => {
  it.todo('selects go to a configured replica and writes go to the primary');
  it.todo('without replica urls the replica handle is the primary');
  it.todo('an explicit url opens that database alone without replicas');
  it.todo('an invalid pool size env falls back to the default');
});
