import { describe, it } from 'vitest';

describe('buildDepGraph', () => {
  it.todo('maps a published entry point back to its source file');
  it.todo('ignores imports that resolve outside the repo');
  it.todo('records an edge for each relative import');
});

describe('impactOf', () => {
  it.todo('returns every transitive dependant of a file');
  it.todo('terminates on an import cycle');
  it.todo('returns nothing for a file nobody imports');
});
