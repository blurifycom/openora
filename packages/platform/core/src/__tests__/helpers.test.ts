import { describe, expect, it, vi } from 'vitest';
import { assertOwnership } from '../ownership.js';
import { serializeRow } from '../serialize-row.js';
import { createEventStreamGenerator } from '../event-stream.js';
import { makeNotFoundError, makeOwnershipError, makeConflictError } from '../domain-error.js';

describe('assertOwnership', () => {
  it('passes when ids match', () => {
    expect(() => assertOwnership('u1', 'u1', new Error('x'))).not.toThrow();
  });

  it('throws the provided error when ids differ', () => {
    const err = new Error('not yours');
    expect(() => assertOwnership('u1', 'u2', err)).toThrow(err);
  });
});

describe('serializeRow', () => {
  it('converts date and decimal fields to strings, leaves the rest', () => {
    const row = {
      id: 'a',
      amount: 12.5,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      name: 'x',
    };
    const out = serializeRow(row, { dateFields: ['createdAt'], decimalFields: ['amount'] });
    expect(out).toEqual({
      id: 'a',
      amount: '12.5',
      createdAt: '2026-01-01T00:00:00.000Z',
      name: 'x',
    });
  });

  it('does not mutate the original row', () => {
    const row = { createdAt: new Date('2026-01-01T00:00:00.000Z') };
    serializeRow(row, { dateFields: ['createdAt'] });
    expect(row.createdAt).toBeInstanceOf(Date);
  });
});

describe('createEventStreamGenerator', () => {
  it('yields primed events then live pushes, and unsubscribes on abort', async () => {
    const controller = new AbortController();
    const unsubscribe = vi.fn();
    let push!: (e: number) => void;
    const gen = createEventStreamGenerator<number>(
      (p) => {
        push = p;
        return unsubscribe;
      },
      { signal: controller.signal, prime: [1] },
    );

    expect((await gen.next()).value).toBe(1);
    push(2);
    expect((await gen.next()).value).toBe(2);

    controller.abort();
    await gen.next();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

describe('domain-error factories', () => {
  it('makeNotFoundError builds a named error with the id in the message', () => {
    const NotFound = makeNotFoundError('Bonus');
    const err = new NotFound('b1');
    expect(err.name).toBe('BonusNotFoundError');
    expect(err.message).toBe('Bonus not found: b1');
  });

  it('makeOwnershipError builds a named ownership error', () => {
    const err = new (makeOwnershipError('ChatMessage'))();
    expect(err.name).toBe('ChatMessageOwnershipError');
  });

  it('makeConflictError uses the given name and message', () => {
    const err = new (makeConflictError('BonusAlreadyClaimedError', 'already claimed'))();
    expect(err.name).toBe('BonusAlreadyClaimedError');
    expect(err.message).toBe('already claimed');
  });
});
