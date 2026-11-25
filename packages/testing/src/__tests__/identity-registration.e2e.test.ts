import { describe, it } from 'vitest';

describe('player registration', () => {
  it.todo(
    'a visitor registers with a 12 character password, age 18 or over and terms accepted and receives a player account with an unverified email',
  );
  it.todo(
    'registration with a password of 11 characters is refused with a validation error and creates no user row',
  );
  it.todo('registration without accepted terms is refused and creates no user row');
  it.todo('registration with a birth date under 18 is refused and creates no user row');
  it.todo('registration with a birth date exactly 18 years ago today succeeds');
  it.todo(
    'registering an email that already exists returns the same neutral result as a fresh email and creates no second account',
  );
  it.todo('registering an email differing only by letter case does not create a second account');
  it.todo('registering a reserved or blocked username is refused');
  it.todo('registering with an unsupported language is refused');
  it.todo(
    'username availability reports a taken username as unavailable and a free one as available',
  );
  it.todo('a new player receives a verification email carrying a single use code');
});

describe('email verification', () => {
  it.todo('a player confirms the emailed code and the account becomes email verified');
  it.todo('a wrong code is refused and leaves the email unverified');
  it.todo('an expired code is refused');
  it.todo('a used code cannot be confirmed a second time');
  it.todo('sending verification codes repeatedly is rate limited');
  it.todo('a player cannot verify the email of another player with their own code');
});

describe('email change', () => {
  it.todo(
    'a signed-in player requests an email change and confirms it with the code sent to the new address',
  );
  it.todo('confirming an email change with a code issued for another player is refused');
  it.todo('an anonymous caller cannot request an email change');
});
