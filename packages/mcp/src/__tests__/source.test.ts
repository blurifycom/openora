import { describe, it } from 'vitest';

describe('findCoreSourceRoot', () => {
  it.todo('returns the source root next to the catalog');
  it.todo('returns null when no source tree exists');
});

describe('findUsages', () => {
  it.todo('finds whole-word usages with file and line');
  it.todo('returns nothing for an unknown symbol');
});

describe('findSymbol and outline', () => {
  it.todo('finds an exported function, class or type by name');
  it.todo('returns nothing for an unknown symbol');
  it.todo('outline lines stay within the line width');
});
