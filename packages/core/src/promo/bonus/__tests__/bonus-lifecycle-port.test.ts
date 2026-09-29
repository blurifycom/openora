import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { EventBus } from '@openora/core/server';
import { createBonusLifecyclePort } from '../service/bonus-lifecycle-port.service.js';
import {
  GrantNotFoundError,
  GrantNotForfeitableError,
  type GrantLifecycleService,
} from '../service/grant-lifecycle.service.js';

const fakeBus = () => ({ emit: vi.fn() }) as unknown as EventBus;

const fakeService = (forfeit: GrantLifecycleService['forfeit']) =>
  ({ forfeit }) as unknown as GrantLifecycleService;

describe('createBonusLifecyclePort', () => {
  it('announces promo.bonus.forfeited and returns the closed grant on success', async () => {
    const grantId = randomUUID();
    const userId = randomUUID();
    const bus = fakeBus();
    const port = createBonusLifecyclePort(
      fakeService(async () => ({
        grantId,
        userId,
        currency: 'USD',
        forfeitedAmount: '42',
        actorId: null,
      })),
      bus,
    );

    const outcome = await port.forfeit(grantId, 'terms_breach', 'missed a required wagering day');

    expect(outcome).toEqual({ ok: true, grantId, userId, currency: 'USD', forfeitedAmount: '42' });
    expect(bus.emit).toHaveBeenCalledWith('promo.bonus.forfeited', {
      userId,
      grantId,
      currency: 'USD',
      forfeitedAmount: '42',
      reason: 'terms_breach',
      actorId: null,
    });
  });

  it('maps a not-found grant to ok:false without emitting anything', async () => {
    const bus = fakeBus();
    const port = createBonusLifecyclePort(
      fakeService(async () => {
        throw new GrantNotFoundError(randomUUID());
      }),
      bus,
    );

    const outcome = await port.forfeit(randomUUID(), 'terms_breach', 'no such grant');

    expect(outcome).toEqual({ ok: false, reason: 'not_found' });
    expect(bus.emit).not.toHaveBeenCalled();
  });

  it('maps a grant that already closed some other way to ok:false, not-forfeitable', async () => {
    const bus = fakeBus();
    const port = createBonusLifecyclePort(
      fakeService(async () => {
        throw new GrantNotForfeitableError();
      }),
      bus,
    );

    const outcome = await port.forfeit(randomUUID(), 'terms_breach', 'already closed');

    expect(outcome).toEqual({ ok: false, reason: 'not_forfeitable' });
    expect(bus.emit).not.toHaveBeenCalled();
  });

  it('rethrows an error the service did not define', async () => {
    const bus = fakeBus();
    const port = createBonusLifecyclePort(
      fakeService(async () => {
        throw new Error('db exploded');
      }),
      bus,
    );

    await expect(port.forfeit(randomUUID(), 'terms_breach', 'note')).rejects.toThrow('db exploded');
  });
});
