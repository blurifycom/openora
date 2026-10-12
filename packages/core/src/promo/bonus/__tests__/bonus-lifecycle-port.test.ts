import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createBonusLifecyclePort } from '../service/bonus-lifecycle-port.service.js';
import {
  GrantNotFoundError,
  GrantNotForfeitableError,
  type GrantLifecycleService,
} from '../service/grant-lifecycle.service.js';

const fakeService = (forfeit: GrantLifecycleService['forfeit']) =>
  ({ forfeit }) as unknown as GrantLifecycleService;

describe('createBonusLifecyclePort', () => {
  it('returns the closed grant on success', async () => {
    const grantId = randomUUID();
    const userId = randomUUID();
    const port = createBonusLifecyclePort(
      fakeService(async () => ({
        grantId,
        userId,
        currency: 'USD',
        forfeitedAmount: '42',
        actorId: null,
      })),
    );

    const outcome = await port.forfeit(grantId, 'terms_breach', 'missed a required wagering day');

    expect(outcome).toEqual({ ok: true, grantId, userId, currency: 'USD', forfeitedAmount: '42' });
  });

  it('maps a not-found grant to ok:false', async () => {
    const port = createBonusLifecyclePort(
      fakeService(async () => {
        throw new GrantNotFoundError(randomUUID());
      }),
    );

    const outcome = await port.forfeit(randomUUID(), 'terms_breach', 'no such grant');

    expect(outcome).toEqual({ ok: false, reason: 'not_found' });
  });

  it('maps a grant that already closed some other way to ok:false, not-forfeitable', async () => {
    const port = createBonusLifecyclePort(
      fakeService(async () => {
        throw new GrantNotForfeitableError();
      }),
    );

    const outcome = await port.forfeit(randomUUID(), 'terms_breach', 'already closed');

    expect(outcome).toEqual({ ok: false, reason: 'not_forfeitable' });
  });

  it('rethrows an error the service did not define', async () => {
    const port = createBonusLifecyclePort(
      fakeService(async () => {
        throw new Error('db exploded');
      }),
    );

    await expect(port.forfeit(randomUUID(), 'terms_breach', 'note')).rejects.toThrow('db exploded');
  });
});
