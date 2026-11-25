import { describe, it } from 'vitest';

describe('two factor enrolment', () => {
  it.todo('a player enables two factor, verifies the first code and receives backup codes once');
  it.todo('a wrong first code leaves two factor disabled');
  it.todo('two factor status reports enabled after enrolment and the number of backup codes left');
  it.todo('disabling two factor requires a valid code and removes the trusted devices');
  it.todo('an anonymous caller cannot enable two factor');
});

describe('two factor login', () => {
  it.todo(
    'a player with two factor signs in with password then a valid code and receives a session',
  );
  it.todo('a password alone does not produce a session when two factor is on');
  it.todo('a wrong code is refused and counts toward the two factor lockout');
  it.todo(
    'repeated wrong codes lock the two factor challenge and a later correct code is refused during the lock',
  );
  it.todo('a code from a previous time step is refused');
  it.todo('a code cannot be replayed after a successful login');
});

describe('backup codes', () => {
  it.todo('a backup code signs the player in once and is then spent');
  it.todo('a spent backup code is refused on reuse');
  it.todo('regenerating backup codes invalidates the old set and requires a valid code');
  it.todo('two parallel logins with the same backup code let only one succeed');
});

describe('trusted devices', () => {
  it.todo('a player who trusts a device skips the code on the next login from the same user agent');
  it.todo('a login from a different user agent still asks for the code');
  it.todo('a trusted device stops working after its expiry');
  it.todo('revoking a trusted device makes the next login ask for the code again');
  it.todo('a player cannot revoke a trusted device of another player');
});

describe('two factor delivery failure', () => {
  it.todo('when the code cannot be delivered the login returns a delivery error and no session');
  it.todo('a delivery failure does not count as a wrong code toward the lockout');
  it.todo(
    'a delivery failure is reported to operations without exposing the provider error to the player',
  );
});
