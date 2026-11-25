import { describe, it } from 'vitest';

describe('admin user directory', () => {
  it.todo('an admin with the permission lists users with pagination and a role filter');
  it.todo('listing supports a search by email and returns no player secrets');
  it.todo('fetching one user returns profile, role and status');
  it.todo('fetching an unknown user returns not found');
  it.todo('an admin without the permission is refused with forbidden');
  it.todo('an anonymous caller is refused with unauthorized');
});

describe('admin user update', () => {
  it.todo('an admin updates a user status and the change is audited');
  it.todo('deactivating an admin ends their sessions');
  it.todo('an admin cannot deactivate the last active super admin');
  it.todo('an admin cannot edit a user above their own level');
  it.todo('updating with an invalid status value is refused');
});

describe('platform stats', () => {
  it.todo('the stats route returns counts that match the rows created by the test');
  it.todo('the stats route is refused for an admin without the permission');
});
