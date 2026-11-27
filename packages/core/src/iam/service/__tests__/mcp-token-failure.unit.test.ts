import { DatabaseError } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  McpTokenReauthenticationFailedError,
  McpTokenReauthenticationLockedError,
  McpTokenReauthenticationRequiredError,
  failureSignature,
  reauthenticationRefusal,
} from '../mcp-token.service.js';

describe('reauthenticationRefusal', () => {
  it.each([
    [
      { status: 'second_factor_required' },
      'McpTokenReauthenticationRequiredError',
      'Enter a second-factor code to issue an MCP token',
      { reason: 'reauthentication_required' },
    ],
    [
      { status: 'password_invalid' },
      'McpTokenReauthenticationFailedError',
      'The password or second-factor code is incorrect',
      { reason: 'reauthentication_failed' },
    ],
    [
      { status: 'second_factor_invalid', attemptsLeft: 1 },
      'McpTokenReauthenticationFailedError',
      'The password or second-factor code is incorrect',
      { reason: 'reauthentication_failed', attemptsLeft: 1 },
    ],
    [
      { status: 'locked', lockedUntil: new Date('2026-06-10T12:15:00.000Z') },
      'McpTokenReauthenticationLockedError',
      'Too many incorrect second-factor codes. Try again later',
      { reason: 'reauthentication_locked', lockedUntil: '2026-06-10T12:15:00.000Z' },
    ],
  ] as const)('refuses %j with %s', (outcome, name, message, data) => {
    const error = reauthenticationRefusal(outcome);
    expect(error.name).toBe(name);
    expect(error.message).toBe(message);
    expect(error).toHaveProperty('data', data);
  });

  it('asks for a second factor when one is required', () => {
    expect(reauthenticationRefusal({ status: 'second_factor_required' })).toBeInstanceOf(
      McpTokenReauthenticationRequiredError,
    );
  });

  it('reports the lock deadline as ISO', () => {
    const until = new Date('2026-06-10T12:15:00.000Z');
    const error = reauthenticationRefusal({ status: 'locked', lockedUntil: until });
    expect(error).toBeInstanceOf(McpTokenReauthenticationLockedError);
    expect(error).toHaveProperty('data.lockedUntil', '2026-06-10T12:15:00.000Z');
  });

  it('reports attempts left for a wrong second-factor code', () => {
    const error = reauthenticationRefusal({ status: 'second_factor_invalid', attemptsLeft: 2 });
    expect(error).toBeInstanceOf(McpTokenReauthenticationFailedError);
    expect(error).toHaveProperty('data.attemptsLeft', 2);
  });

  it('gives a wrong password the same message and no attempts count', () => {
    const password = reauthenticationRefusal({ status: 'password_invalid' });
    const code = reauthenticationRefusal({ status: 'second_factor_invalid' });
    expect(password).toBeInstanceOf(McpTokenReauthenticationFailedError);
    expect(password.message).toBe(code.message);
    expect(password).toEqual(code);
    expect(password).not.toHaveProperty('data.attemptsLeft');
  });
});

describe('failureSignature', () => {
  const tokenHash = 'a3f9c2d4e5b6071829384756afbecd01a3f9c2d4e5b6071829384756afbecd01';

  it('describes a non-Error by its type only', () => {
    expect(failureSignature('boom')).toEqual({ name: 'string', code: null });
    expect(failureSignature(null)).toEqual({ name: 'object', code: null });
    expect(failureSignature(undefined)).toEqual({ name: 'undefined', code: null });
  });

  it('names the error class with a null code when there is no sql state', () => {
    expect(failureSignature(new TypeError('x'))).toEqual({ name: 'TypeError', code: null });
  });

  it('never carries the message, stack or cause text', () => {
    const error = new Error(`duplicate key value (token_hash)=(${tokenHash})`, {
      cause: new Error(`insert ... values ('${tokenHash}')`),
    });
    const signature = JSON.stringify(failureSignature(error));
    expect(signature).not.toContain(tokenHash);
    expect(signature).not.toContain('duplicate');
    expect(signature).not.toContain('insert');
  });

  it('reads the sql state from a database error without its message', () => {
    const error = new DatabaseError(`key (token_hash)=(${tokenHash}) exists`, 0, 'error');
    error.code = '23505';
    expect(failureSignature(error)).toEqual({ name: 'DatabaseError', code: '23505' });
  });

  it('reads the sql state from a wrapped database error cause', () => {
    const cause = new DatabaseError('x', 0, 'error');
    cause.code = '40001';
    expect(failureSignature(new Error('wrapped', { cause }))).toEqual({
      name: 'Error',
      code: '40001',
    });
  });

  it('keeps only name and code keys', () => {
    expect(Object.keys(failureSignature(new Error(tokenHash))).sort()).toEqual(['code', 'name']);
  });
});
