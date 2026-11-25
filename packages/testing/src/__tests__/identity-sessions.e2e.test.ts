import { describe, it } from 'vitest';

describe('session management', () => {
  it.todo(
    'a player lists their sessions and sees device label, country and the current one marked',
  );
  it.todo('a player revokes another session and that session is refused on its next request');
  it.todo('a player cannot revoke a session of another player');
  it.todo('revoking the current session through the other-session route is refused');
  it.todo('revoke all ends every session except the current one');
  it.todo('a revoked session is closed on the live session stream');
  it.todo('logout ends the session and the cookie no longer authenticates');
  it.todo('an idle session past the auto logout setting is refused');
  it.todo('a mid-session IP change under the strict policy ends the session');
});

describe('player security controls', () => {
  it.todo(
    'a player sets the auto logout interval and the setting is returned by the security status',
  );
  it.todo('a player enables the login and withdrawal alert and the setting persists');
  it.todo('a player sets a withdrawal PIN and a wrong PIN is refused afterwards');
  it.todo('removing the withdrawal PIN requires the current credentials');
  it.todo('setting an anti phishing code shows it in later security emails');
  it.todo('a player requires two factor on withdrawals and the setting persists');
  it.todo('a player verifies a phone with a code and a wrong code is refused');
});
