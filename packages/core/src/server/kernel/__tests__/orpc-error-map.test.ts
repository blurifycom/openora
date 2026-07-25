import { describe, it, expect } from 'vitest';
import { ORPCError } from '@orpc/server';
import { mapErrors } from '../orpc-error-map.js';

class NotFound extends Error {}
class Conflict extends Error {}
class SubNotFound extends NotFound {}

const failWith = (err: unknown) => () => Promise.reject(err);

const caught = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected mapErrors to reject');
};

describe('mapErrors', () => {
  it('returns the resolved value when nothing throws', async () => {
    await expect(mapErrors({ NOT_FOUND: NotFound }, async () => 'ok')).resolves.toBe('ok');
  });

  it('translates a mapped error into the matching oRPC code', async () => {
    const err = await caught(() =>
      mapErrors({ NOT_FOUND: NotFound }, failWith(new NotFound('no'))),
    );

    expect(err).toBeInstanceOf(ORPCError);
    expect((err as ORPCError<string, unknown>).code).toBe('NOT_FOUND');
  });

  it('carries the original message onto the oRPC error', async () => {
    const err = await caught(() =>
      mapErrors({ NOT_FOUND: NotFound }, failWith(new NotFound('game not found: 7'))),
    );

    expect((err as Error).message).toBe('game not found: 7');
  });

  it('accepts a list of classes under one code', async () => {
    const err = await caught(() =>
      mapErrors({ CONFLICT: [NotFound, Conflict] }, failWith(new Conflict('dup'))),
    );

    expect((err as ORPCError<string, unknown>).code).toBe('CONFLICT');
  });

  it('matches a subclass of a mapped error', async () => {
    const err = await caught(() =>
      mapErrors({ NOT_FOUND: NotFound }, failWith(new SubNotFound('deeper'))),
    );

    expect((err as ORPCError<string, unknown>).code).toBe('NOT_FOUND');
  });

  it('rethrows an unmapped error untouched so it surfaces as a 500', async () => {
    const original = new Conflict('unhandled');

    expect(await caught(() => mapErrors({ NOT_FOUND: NotFound }, failWith(original)))).toBe(
      original,
    );
  });

  it('uses the first matching entry when an error matches several codes', async () => {
    const err = await caught(() =>
      mapErrors({ NOT_FOUND: NotFound, CONFLICT: NotFound }, failWith(new NotFound('both'))),
    );

    expect((err as ORPCError<string, unknown>).code).toBe('NOT_FOUND');
  });

  it('leaves an already-mapped ORPCError alone', async () => {
    const original = new ORPCError('FORBIDDEN', { message: 'nope' });

    expect(await caught(() => mapErrors({ NOT_FOUND: NotFound }, failWith(original)))).toBe(
      original,
    );
  });
});
