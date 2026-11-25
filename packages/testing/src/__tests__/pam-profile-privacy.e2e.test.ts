import { describe, it } from 'vitest';

describe('player profile', () => {
  it.todo('a player reads their own profile');
  it.todo('a player updates name, country and language and the profile reflects it');
  it.todo('a player cannot change fields reserved for operators such as status or role');
  it.todo('an unsupported language is refused');
  it.todo('a phone number that does not match the country calling code is refused');
  it.todo('an anonymous caller is refused with unauthorized');
  it.todo('the profile response never includes the password hash or two factor secret');
});

describe('display preferences', () => {
  it.todo('a player sets the display currency and the setting is returned');
  it.todo('an unsupported display currency is refused');
  it.todo(
    'a player sets display decimal places within the allowed range and a value outside it is refused',
  );
});

describe('privacy between players', () => {
  it.todo('one player cannot read the profile card of another player');
  it.todo(
    'the profile card route is refused for a player session and works for an admin with the permission',
  );
  it.todo('admin responses mask fields the admin has no permission to see');
});
