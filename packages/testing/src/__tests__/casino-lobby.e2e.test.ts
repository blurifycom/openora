import { describe, it } from 'vitest';

describe('lobby layout and sections', () => {
  it.todo(
    'an admin replaces the lobby layout and the public layout returns the new sections in order',
  );
  it.todo(
    'a layout keyed by name returns only that layout and an unknown key returns the default or not found',
  );
  it.todo('a section referencing a category that does not exist is refused');
  it.todo('replacing the layout with duplicate section positions is refused');
  it.todo('a non-admin calling replace or admin get layout is refused as forbidden');
  it.todo('the public featured list contains only active games');
  it.todo('lobby search returns matching active games and ignores inactive ones');
  it.todo('lobby search with an empty or over-long query is rejected by validation');
  it.todo('a category fetched by an unknown slug returns not found');
});
