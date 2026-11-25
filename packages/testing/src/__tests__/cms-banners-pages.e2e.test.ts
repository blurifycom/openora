import { describe, it } from 'vitest';

describe('admin banner placements', () => {
  it.todo(
    "an admin creates a banner configuration for a placement and it appears in that placement's list",
  );
  it.todo(
    'setting a default banner for a placement makes the public banner return it and unsetting removes it',
  );
  it.todo('setting a banner image within the allowed dimensions and size succeeds');
  it.todo('setting a banner image outside the allowed dimensions or size is refused');
  it.todo('a banner image URL on a host that is not allowed or not https is refused');
  it.todo('a schedule with an end before its start is refused as invalid range');
  it.todo('a scheduled banner is public only inside its window');
  it.todo('deleting or setting the default of an unknown banner returns not found');
  it.todo('a non-admin calling any banner write route is refused as forbidden');
  it.todo('the public banner of a placement without any banner returns empty and not an error');
});

describe('admin pages and publishing', () => {
  it.todo('an admin creates a page and the public page read returns it by slug');
  it.todo('an unpublished page is not returned by the public read');
  it.todo('publishing a page makes it public and unpublishing hides it again');
  it.todo('creating a page with a slug already in use is refused with a conflict');
  it.todo('updating and deleting a page are audited and a deleted page returns not found');
  it.todo('a non-admin creating, updating or deleting a page is refused as forbidden');
});
