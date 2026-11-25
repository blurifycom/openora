import { describe, it } from 'vitest';

describe('mcpTokenStatus', () => {
  it.todo('a revoked token is revoked even when it is also expired');
  it.todo('a token past its expiry is expired');
  it.todo('a token expiring exactly now is expired');
  it.todo('a token before expiry and not revoked is active');
});

describe('mcpTokenAuthentication', () => {
  it.todo('an undefined token is refused as unknown');
  it.todo('a revoked or expired token is refused with its status as the reason');
  it.todo('a token created at or before the credential change is refused as credentials changed');
  it.todo('a token created after the credential change is accepted');
  it.todo('a token with no credential change is accepted');
});

describe('token format and hashing', () => {
  it.todo('a generated token matches the token format check');
  it.todo('a value without the token prefix does not match the format check');
  it.todo('the hash is stable for the same token and differs between tokens');
  it.todo('the display prefix never contains the full secret');
});
