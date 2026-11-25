import { describe, it } from 'vitest';

describe('levelRank and isLevelSufficient', () => {
  it.todo('ranks no_access below read below read_write');
  it.todo('a level is sufficient for itself and any lower level');
  it.todo('a lower level is not sufficient for a higher one');
});

describe('levelToActions', () => {
  it.todo('no_access yields no actions');
  it.todo('read_write yields every action of the resource');
  it.todo('read yields only view for a resource that has view');
  it.todo('read yields nothing for a resource without view');
  it.todo('an unknown resource yields no actions');
});

describe('actionsToLevel', () => {
  it.todo('all actions collapse to read_write');
  it.todo('only view collapses to read');
  it.todo('a partial non view set collapses to no_access');
  it.todo('an unknown resource or empty action list collapses to no_access');
});
