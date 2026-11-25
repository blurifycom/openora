import { describe, it } from 'vitest';

describe('admin two factor is mandatory', () => {
  it.todo(
    'an admin without two factor can sign in only to the enrolment step and every other admin route is refused',
  );
  it.todo('an admin completes enrolment and reaches the admin routes');
  it.todo('an admin cannot disable two factor while the policy is mandatory');
  it.todo('an admin with two factor needs a code at every sign in from an untrusted device');
});

describe('admin trusted devices', () => {
  it.todo('an admin trusts the current device and skips the code on the next sign in');
  it.todo('an admin lists and revokes a trusted device');
  it.todo('a super admin revokes all trusted devices of another admin');
  it.todo('an admin without the permission cannot revoke trusted devices of another admin');
});

describe('two factor reset', () => {
  it.todo('a super admin resets the two factor of another admin and that admin must enrol again');
  it.todo(
    'an admin resets the two factor of a player with the permission and the player sessions end',
  );
  it.todo('a reset without the permission is refused with forbidden');
  it.todo('an admin cannot reset their own two factor through the admin reset route');
  it.todo('every reset is recorded in the audit log with actor and target');
});

describe('admin sessions', () => {
  it.todo('an admin lists all admin sessions with the permission');
  it.todo('an admin without the permission cannot list all sessions');
  it.todo('an admin force logs out another admin session');
});
