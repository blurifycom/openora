import { describe, it } from 'vitest';

describe('password reset', () => {
  it.todo('a player requests a reset and receives a code by email');
  it.todo(
    'forgot password for an unknown email returns the same neutral result and sends no email',
  );
  it.todo(
    'a valid code lets the player set a new 12 character password and the old one stops working',
  );
  it.todo('a new password shorter than 12 characters is refused');
  it.todo('a wrong or expired reset code is refused');
  it.todo('a reset code cannot be used twice');
  it.todo('a completed reset ends every other session of the player');
  it.todo('a session created while the reset is committing is also ended');
  it.todo('a reset code issued for one player cannot reset another');
});

describe('password change', () => {
  it.todo(
    'a signed-in player changes the password with the correct current password and keeps the current session',
  );
  it.todo('a change with a wrong current password is refused and the password is unchanged');
  it.todo('a successful change ends every other session of the player');
  it.todo('a session created in a race with the change is ended too');
  it.todo('a new password equal to the current one is refused');
  it.todo('an anonymous caller cannot change a password');
});

describe('admin initiated reset', () => {
  it.todo(
    'an admin with the permission triggers a player password reset and the player sessions end',
  );
  it.todo('an admin without the permission is refused with forbidden');
  it.todo('the reset is recorded in the audit log with the acting admin');
});
