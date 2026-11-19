import { describe, it, expect } from 'vitest';
import * as z from 'zod';
import {
  KycQueueInputSchema,
  RgFlagsQueueInputSchema,
  RgPlayerStateInputSchema,
} from '../contract/index.js';

const PLAYER_ID = '11111111-1111-4111-8111-111111111111';

describe('rg.player_state input', () => {
  const parse = (input: unknown) => z.safeParse(RgPlayerStateInputSchema, input);

  it('defaults to the 7, 30 and 90 day windows', () => {
    expect(parse({ playerId: PLAYER_ID })).toEqual({
      success: true,
      data: { playerId: PLAYER_ID, windowDays: [7, 30, 90] },
    });
  });

  it('takes 1 to 4 windows of 1 to 365 days, and a player id only', () => {
    expect(parse({ playerId: PLAYER_ID, windowDays: ['1', 365] }).success).toBe(true);
    expect(parse({ playerId: PLAYER_ID, windowDays: [] }).success).toBe(false);
    expect(parse({ playerId: PLAYER_ID, windowDays: [1, 2, 3, 4, 5] }).success).toBe(false);
    expect(parse({ playerId: PLAYER_ID, windowDays: [366] }).success).toBe(false);
    expect(parse({ playerId: 'p_abcdefghijklmnop' }).success).toBe(false);
  });
});

describe('rg.flags_queue and kyc.queue input', () => {
  it('default to the 10 oldest and take a limit from 1 to 20', () => {
    expect(z.safeParse(RgFlagsQueueInputSchema, {})).toEqual({
      success: true,
      data: { limit: 10 },
    });
    expect(z.safeParse(KycQueueInputSchema, {})).toEqual({ success: true, data: { limit: 10 } });
    expect(z.safeParse(RgFlagsQueueInputSchema, { limit: '20' }).success).toBe(true);
    expect(z.safeParse(RgFlagsQueueInputSchema, { limit: 21 }).success).toBe(false);
    expect(z.safeParse(KycQueueInputSchema, { limit: 0 }).success).toBe(false);
  });

  it('narrow only by a flag type or a tier they know', () => {
    expect(z.safeParse(RgFlagsQueueInputSchema, { flagType: 'session_time' }).success).toBe(true);
    expect(z.safeParse(RgFlagsQueueInputSchema, { flagType: 'chasing_losses' }).success).toBe(
      false,
    );
    expect(z.safeParse(KycQueueInputSchema, { tier: 'advanced' }).success).toBe(true);
    expect(z.safeParse(KycQueueInputSchema, { tier: 'premium' }).success).toBe(false);
  });

  it('narrows kyc.queue only to a status the queue holds', () => {
    expect(z.safeParse(KycQueueInputSchema, { status: 'resubmission_requested' }).success).toBe(
      true,
    );
    expect(z.safeParse(KycQueueInputSchema, { status: 'pending' }).success).toBe(true);
    expect(z.safeParse(KycQueueInputSchema, { status: 'approved' }).success).toBe(false);
  });
});
