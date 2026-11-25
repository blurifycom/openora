import { describe, it } from 'vitest';

describe('admin manages game categories and rules', () => {
  it.todo(
    'an admin creates a category with a unique slug and it shows in the public category list',
  );
  it.todo('creating a category with a slug already in use is refused with a conflict');
  it.todo('an admin updates a category and the change is audited');
  it.todo('a category rule previews the matching games without saving membership');
  it.todo('a rule that matches too many games is refused as too broad');
  it.todo('evaluating membership adds newly matching games and removes games that no longer match');
  it.todo(
    'a rule that cannot be resolved returns service unavailable and leaves membership unchanged',
  );
  it.todo('a non-admin player calling any category write route is refused as forbidden');
  it.todo('an admin without the rule reporting permission cannot save a rule category');
});

describe('admin orders games inside a category', () => {
  it.todo('reordering category games stores the manual order and the public list returns it');
  it.todo('pinned games always rank above unpinned games regardless of the sort option');
  it.todo('pinning a game that is not a member of the category is refused as bad request');
  it.todo('reordering a category that does not exist returns not found');
  it.todo('choosing a sort option with an invalid config is refused');
  it.todo('a repeated reorder with the same payload leaves the ranking unchanged');
  it.todo('a non-admin calling reorder or pin is refused as forbidden');
});

describe('admin manages providers, tags and bulk edits', () => {
  it.todo('an admin creates and updates a provider and the change is audited');
  it.todo('a provider logo URL on a host that is not allowed is refused');
  it.todo('an admin creates a tag and assigns it to games in bulk');
  it.todo('a bulk edit on games writes one audit row and leaves unrelated games untouched');
  it.todo('a non-admin calling any provider, tag or bulk route is refused as forbidden');
});
