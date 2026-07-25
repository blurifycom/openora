import { describe, it, expect } from 'vitest';
import { createDomainError, alreadyInUseError } from '../domain-error.js';

describe('createDomainError', () => {
  const InsufficientFundsError = createDomainError<[balance: string, requested: string]>(
    'InsufficientFundsError',
    (balance, requested) => `balance ${balance} cannot cover ${requested}`,
  );

  it('builds the message from the constructor arguments', () => {
    expect(new InsufficientFundsError('10.00', '25.00').message).toBe(
      'balance 10.00 cannot cover 25.00',
    );
  });

  it('names the error so a log line identifies it without a stack', () => {
    expect(new InsufficientFundsError('0', '1').name).toBe('InsufficientFundsError');
  });

  it('stays an Error so a generic catch still works', () => {
    expect(new InsufficientFundsError('0', '1')).toBeInstanceOf(Error);
  });

  it('is instanceof-matchable, which is what the router error map keys on', () => {
    expect(new InsufficientFundsError('0', '1')).toBeInstanceOf(InsufficientFundsError);
  });

  it('keeps two error types built from the same factory distinct', () => {
    const Other = createDomainError<[]>('OtherError', () => 'other');

    expect(new InsufficientFundsError('0', '1')).not.toBeInstanceOf(Other);
  });

  it('captures a stack trace', () => {
    expect(new InsufficientFundsError('0', '1').stack).toContain('InsufficientFundsError');
  });

  it('supports a message that takes no arguments', () => {
    const Frozen = createDomainError<[]>('FrozenError', () => 'account is frozen');

    expect(new Frozen().message).toBe('account is frozen');
  });
});

describe('alreadyInUseError', () => {
  const EmailAlreadyInUseError = alreadyInUseError('Email');

  it('names the error after the entity', () => {
    expect(new EmailAlreadyInUseError().name).toBe('EmailAlreadyInUseError');
  });

  it('reads as a conflict without leaking the offending value', () => {
    expect(new EmailAlreadyInUseError().message).toBe('Email is already in use');
  });

  it('keeps two entities distinct', () => {
    expect(new EmailAlreadyInUseError()).not.toBeInstanceOf(alreadyInUseError('Phone'));
  });
});
