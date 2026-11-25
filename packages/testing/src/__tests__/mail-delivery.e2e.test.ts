import { describe, it } from 'vitest';

describe('transactional and promotional mail', () => {
  it.todo('registering a player delivers a welcome mail to the registered address');
  it.todo('requesting email verification delivers a mail carrying the verification code');
  it.todo('a verification code mail is delivered once for a repeated idempotency key');
  it.todo('a promotional mail is not sent to a player who opted out of marketing');
  it.todo('a mail to a player without an email address is skipped without throwing');
  it.todo(
    'a failing sender retries and, once exhausted, records the failure without losing the job',
  );
});
