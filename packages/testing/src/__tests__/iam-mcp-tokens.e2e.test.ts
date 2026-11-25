import { describe, it } from 'vitest';

describe('own agent tokens', () => {
  it.todo('an admin creates a token with a ttl within the policy and sees the secret once');
  it.todo('a ttl above the policy maximum is refused');
  it.todo('creating a token while the feature is disabled is refused');
  it.todo('creation requires a fresh two factor code');
  it.todo('listing own tokens never returns the secret and shows the display prefix and status');
  it.todo('an admin revokes an own token with a reason and the token stops authenticating');
  it.todo('an admin cannot revoke the token of another admin through the own token route');
  it.todo('revoking an already revoked token keeps the first revoke reason');
});

describe('token administration', () => {
  it.todo('a super admin lists the tokens of every admin');
  it.todo(
    'a super admin revokes one token of another admin with a reason and the reason is stored',
  );
  it.todo('revoke all ends every active token and records one reason');
  it.todo('a non super admin is refused on the administration routes');
  it.todo(
    'a token issued before the admin changed their password is refused as credentials changed',
  );
  it.todo('an expired token is refused with the expired reason');
  it.todo('an unknown token is refused without revealing whether it ever existed');
});
