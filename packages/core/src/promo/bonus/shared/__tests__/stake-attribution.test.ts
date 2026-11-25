import { describe, it } from 'vitest';

describe('attributeStake', () => {
  it.todo("a grant's own bonus stake progresses that grant only");
  it.todo('real stake fills the first grant up to its headroom and carries the rest to the next');
  it.todo("carried stake is weighted by the next grant's own percent");
  it.todo("progress never exceeds a grant's headroom");
  it.todo('real stake no grant absorbs stays on the first grant with no progress');
  it.todo('an empty grant list attributes nothing');
});
