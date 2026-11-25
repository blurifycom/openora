import { describe, it } from 'vitest';

describe('role management', () => {
  it.todo('a super admin creates a role with per module levels and the role is listed');
  it.todo('a role name that already exists is refused with a conflict');
  it.todo('a super admin updates the permissions of a role and the change is audited');
  it.todo('a protected role cannot be renamed, edited or deleted');
  it.todo('deleting a role that is assigned is refused or unassigns it as documented');
  it.todo('a non super admin cannot create, update or delete a role');
  it.todo('an admin cannot grant a level above their own on any module');
});

describe('role assignment', () => {
  it.todo('assigning a role gives the admin its permissions on the next request');
  it.todo('an admin with two roles holds the union of both roles permissions');
  it.todo('removing one of two roles keeps only the permissions of the remaining one');
  it.todo('assigning a role to a player account is refused as not an admin user');
  it.todo('assigning a role to an unknown user returns not found');
  it.todo('the last active super admin cannot be unassigned');
  it.todo('two parallel unassignments of two super admins never leave zero super admins');
  it.todo('a role change ends the sessions of the affected admin');
  it.todo('a role change does not end the sessions of other admins');
});

describe('forbidden admin routes', () => {
  it.todo('an admin with no access to a module is refused with forbidden on that module routes');
  it.todo('an admin with read level can read but a write route is refused');
  it.todo('an admin with read write level can call the write route');
  it.todo('a denied admin route reports the access denial to the audit log');
  it.todo('effective permissions for a user reflect the stored levels');
  it.todo('an anonymous caller is refused with unauthorized on every admin route');
});

describe('invitations', () => {
  it.todo(
    'an admin with the permission invites an email into a role and the invitee receives a token email',
  );
  it.todo('accepting a valid invitation creates an admin account with the role');
  it.todo('an invitation token cannot be accepted twice');
  it.todo('an expired invitation token is refused');
  it.todo('inviting an email that already has an account is refused');
  it.todo('accepting with a password shorter than 12 characters is refused');
});

describe('two person approval', () => {
  it.todo('a request that needs approval stays pending until a different admin approves it');
  it.todo('the requesting admin cannot approve their own request');
  it.todo('an admin without the approve permission cannot approve');
  it.todo('a request approved twice applies once');
  it.todo('a rejected request never applies and records the reason');
});
