import { describe, it } from 'vitest';

describe('player login', () => {
  it.todo('a verified player signs in with the correct credentials and receives a session');
  it.todo('a wrong password and an unknown email return the same generic error text');
  it.todo('a login with the wrong password reports the remaining attempts');
  it.todo('a suspended or closed player cannot sign in');
  it.todo('a successful login clears the failed attempt counter');
  it.todo('a login records the device and country on the session');
});

describe('login lockout escalation', () => {
  it.todo(
    'the fifth consecutive wrong password locks the account for one minute and returns the lock expiry',
  );
  it.todo('a correct password during an active lockout is still refused with the locked error');
  it.todo(
    'after the one minute lock expires and five more failures the account locks for five minutes',
  );
  it.todo(
    'after the five minute lock expires and five more failures the account locks for fifteen minutes',
  );
  it.todo('further lockouts after the third stay at fifteen minutes');
  it.todo('the lockout level resets after a day without failures');
  it.todo('a locked account does not reveal whether the email exists');
  it.todo('the unlock route with a valid emailed code ends the lockout');
  it.todo('the unlock route with a wrong code leaves the lockout in place');
  it.todo('two parallel wrong-password bursts on one account still lock it once at the first tier');
});

describe('phone login', () => {
  it.todo('a player with a verified phone requests a code and signs in with it');
  it.todo('a wrong phone code is refused and counts toward the lockout');
  it.todo('a phone number that belongs to no player gets the same neutral response as a known one');
});

describe('side separation', () => {
  it.todo(
    'a player credential cannot sign in through the admin sign-in and no admin session is created',
  );
  it.todo('an admin credential cannot sign in as a player and no player session is created');
  it.todo('a player session is refused by every admin route with forbidden');
});
