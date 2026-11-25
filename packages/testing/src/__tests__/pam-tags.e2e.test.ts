import { describe, it } from 'vitest';

describe('tag lifecycle', () => {
  it.todo('an admin creates a tag with a key and the tag is listed');
  it.todo('creating a tag with an existing key is refused with a conflict');
  it.todo('deleting an unused tag succeeds');
  it.todo('deleting a tag that is assigned to a player is refused as in use');
  it.todo('an admin without the permission cannot create or delete a tag');
});

describe('manual assignment', () => {
  it.todo('an admin assigns a tag to a player and the player tag list shows it as active');
  it.todo(
    'assigning a tag the player already holds is reported as already active and adds no second row',
  );
  it.todo('two parallel assignments of the same tag leave one active assignment');
  it.todo('assigning to an unknown player returns not found');
  it.todo('assigning a tag the player is not eligible for is refused');
  it.todo('an admin lists the tags assignable to a player without the ones already held');
  it.todo('removal requires a reason and an empty reason is refused');
  it.todo('removing a tag marks the assignment removed and keeps the history row');
  it.todo('removing a tag the player does not hold returns not found');
});

describe('automatic tags', () => {
  it.todo(
    'a player crossing a rule threshold receives the automatic tag after the evaluation event',
  );
  it.todo('a player falling back under the threshold loses a non sticky automatic tag');
  it.todo('a sticky tag stays after the player falls back under the threshold');
  it.todo('a manually removed automatic tag is not re-applied by the next evaluation');
  it.todo('a disabled rule applies no tag');
  it.todo('an admin updates a rule threshold and the next evaluation uses it');
  it.todo('a rule for an unknown tag key is refused');
  it.todo('updating a rule without the permission is refused with forbidden');
});

describe('tag that excludes automatic withdrawal', () => {
  it.todo('a player holding the excluding tag has an eligible withdrawal routed to manual review');
  it.todo('removing the tag lets the next eligible withdrawal be paid automatically');
  it.todo('a player without the tag is not affected');
});
