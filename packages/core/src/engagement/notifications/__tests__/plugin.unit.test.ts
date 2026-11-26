import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { DomainEventPayload } from '@openora/core/contracts';
import {
  buildChatRoomScheduledForDeletionNotification,
  buildKycResubmissionNotification,
  buildRgLimitAdminUpdatedNotification,
  compactData,
} from '../plugin.js';

const USER = 'a1b2c3d4-0000-4000-8000-000000000001';
const EVENT = 'a1b2c3d4-0000-4000-8000-0000000000ee';

describe('compactData', () => {
  it('drops null and undefined and keeps the rest', () => {
    expect(compactData({ a: '1', b: null, c: undefined, d: '4' })).toEqual({ a: '1', d: '4' });
  });

  it('keeps an empty string and the string zero', () => {
    expect(compactData({ a: '', b: '0' })).toEqual({ a: '', b: '0' });
  });

  it.each([[{}], [{ a: null }], [{ a: undefined, b: null }]])('turns %j into null', (fields) => {
    expect(compactData(fields)).toBeNull();
  });

  it('keeps every present value untouched and loses no key', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string({ minLength: 1, maxLength: 6 }).filter((key) => key !== '__proto__'),
          fc.option(fc.string(), { nil: undefined }),
        ),
        (fields) => {
          const present = Object.entries(fields).filter(([, value]) => value !== undefined);
          const result = compactData(fields);
          expect(result === null).toBe(present.length === 0);
          expect(Object.entries(result ?? {})).toEqual(present);
        },
      ),
    );
  });
});

describe('buildKycResubmissionNotification', () => {
  it('passes the reason and tier of a basic request', () => {
    expect(
      buildKycResubmissionNotification({
        userId: USER,
        reason: 'blurry photo',
        tier: 'basic',
        eventId: EVENT,
      }),
    ).toEqual({
      userId: USER,
      type: 'kyc.resubmission_requested',
      params: { reason: 'blurry photo', tier: 'basic' },
      data: null,
      eventId: EVENT,
    });
  });

  it('drops the internal reason of an advanced request', () => {
    const result = buildKycResubmissionNotification({
      userId: USER,
      reason: 'source of funds looks like a mule account',
      tier: 'advanced',
    });
    expect(result.params).toEqual({ tier: 'advanced' });
    expect(JSON.stringify(result)).not.toContain('mule');
  });

  it.each([null, ''])('omits the reason when it is %j', (reason) => {
    expect(
      buildKycResubmissionNotification({ userId: USER, reason, tier: 'basic' }).params,
    ).toEqual({
      tier: 'basic',
    });
  });

  it('keeps a whitespace only reason, as it is non-empty', () => {
    expect(
      buildKycResubmissionNotification({ userId: USER, reason: ' ', tier: 'basic' }).params,
    ).toEqual({
      reason: ' ',
      tier: 'basic',
    });
  });

  it('carries a null event id when the job had none', () => {
    expect(
      buildKycResubmissionNotification({ userId: USER, reason: null, tier: 'basic' }).eventId,
    ).toBeNull();
  });
});

describe('buildChatRoomScheduledForDeletionNotification', () => {
  it('names the room in params and keeps the id in data', () => {
    expect(
      buildChatRoomScheduledForDeletionNotification({
        userId: USER,
        roomId: 'room-1',
        roomName: 'High rollers',
      }),
    ).toEqual({
      userId: USER,
      type: 'chat.room.scheduled_for_deletion',
      params: { roomName: 'High rollers' },
      data: { roomId: 'room-1' },
    });
  });
});

describe('buildRgLimitAdminUpdatedNotification', () => {
  const payload = (
    over: Partial<DomainEventPayload<'rg.limit.set'>>,
  ): DomainEventPayload<'rg.limit.set'> => ({
    userId: USER,
    playerId: null,
    actorId: 'a1b2c3d4-0000-4000-8000-0000000000aa',
    limitId: 'a1b2c3d4-0000-4000-8000-0000000000bb',
    type: 'deposit',
    period: 'daily',
    amount: '100',
    minutes: null,
    previousAmount: '500',
    previousMinutes: null,
    currency: 'USD',
    previousCurrency: 'USD',
    initiatedBy: 'admin',
    reason: null,
    ...over,
  });

  it('maps a money limit and leaves minutes out', () => {
    expect(buildRgLimitAdminUpdatedNotification(payload({}))).toEqual({
      userId: USER,
      type: 'rg.limit.admin_updated',
      params: {
        period: 'daily',
        limitType: 'deposit',
        previousAmount: '500',
        amount: '100',
        currency: 'USD',
        previousCurrency: 'USD',
      },
      data: null,
    });
  });

  it('maps a session limit with minutes as strings', () => {
    const result = buildRgLimitAdminUpdatedNotification(
      payload({
        type: 'session',
        period: 'session',
        amount: null,
        minutes: 90,
        previousAmount: null,
        previousMinutes: 120,
        currency: null,
        previousCurrency: null,
      }),
    );
    expect(result.params).toEqual({
      period: 'session',
      limitType: 'session',
      previousMinutes: '120',
      minutes: '90',
    });
  });

  it('keeps a zero minutes limit as the string 0', () => {
    expect(
      buildRgLimitAdminUpdatedNotification(payload({ minutes: 0, previousMinutes: 0 })).params,
    ).toMatchObject({
      minutes: '0',
      previousMinutes: '0',
    });
  });

  it('never copies the admin reason into what the player sees', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 8 }), (reason) => {
        const withReason = buildRgLimitAdminUpdatedNotification(payload({ reason }));
        const withoutReason = buildRgLimitAdminUpdatedNotification(payload({ reason: null }));
        expect(withReason).toEqual(withoutReason);
      }),
    );
  });

  it('does not leak the reason or the acting admin', () => {
    const result = buildRgLimitAdminUpdatedNotification(
      payload({ reason: 'suspected gambling addiction, see case 4471' }),
    );
    const text = JSON.stringify(result);
    expect(text).not.toContain('addiction');
    expect(text).not.toContain('a1b2c3d4-0000-4000-8000-0000000000aa');
  });
});
