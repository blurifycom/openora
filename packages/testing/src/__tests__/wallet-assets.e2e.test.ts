import { describe, it } from 'vitest';

describe('admin wallet asset catalog', () => {
  it.todo(
    'an admin creating an asset for a currency and network makes it appear in the public enabled list',
  );
  it.todo(
    'an admin updating minimums, fee and deposit or withdrawal switches changes what players are allowed',
  );
  it.todo('a switched-off asset does not appear in the public enabled list');
  it.todo('creating the same currency and network twice is refused as already existing');
  it.todo('creating an asset for an unsupported network or unknown provider is refused');
  it.todo(
    'deleting an asset with issued deposit addresses, in-flight transactions or in use is refused',
  );
  it.todo('a non-admin creating, updating or deleting an asset is refused with 403');
  it.todo(
    'an unauthenticated caller listing the public assets still sees only enabled assets without admin fields',
  );
});
