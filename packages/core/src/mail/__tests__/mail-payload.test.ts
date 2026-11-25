import { describe, it } from 'vitest';

describe('mail payload cipher', () => {
  it.todo('a payload round trips through encrypt and decrypt');
  it.todo('a secret shorter than the minimum length is rejected');
  it.todo('a tampered payload fails to decrypt');
  it.todo('the same payload encrypts to different ciphertexts');
});
