import { describe, it, expect } from 'vitest';
import { toTag, toPlayerTagWithTag, toTagRule } from '../service/tag-mappers.js';

const ISO = '2024-01-01T00:00:00.000Z';
const DATE = new Date(ISO);

const TAG_ID = '11111111-1111-4111-8111-111111111111';
const PLAYER_ID = '22222222-2222-4222-8222-222222222222';
const PT_ID = '33333333-3333-4333-8333-333333333333';
const RULE_ID = '44444444-4444-4444-8444-444444444444';
const ACTOR_ID = '55555555-5555-4555-8555-555555555555';

describe('toTag', () => {
  it('converts Date fields to ISO strings', () => {
    const result = toTag({
      id: TAG_ID,
      key: 'high_roller',
      isSticky: false,
      createdAt: DATE,
      updatedAt: DATE,
    });
    expect(result).toEqual({
      id: TAG_ID,
      key: 'high_roller',
      isSticky: false,
      createdAt: ISO,
      updatedAt: ISO,
    });
  });
});

describe('toPlayerTagWithTag', () => {
  it('converts Date fields to ISO strings and attaches tag key', () => {
    const result = toPlayerTagWithTag(
      {
        id: PT_ID,
        playerId: PLAYER_ID,
        tagId: TAG_ID,
        assignReason: 'reason',
        assignActor: 'manual',
        assignActorUserId: ACTOR_ID,
        assignMetadata: null,
        removedAt: null,
        removalReason: null,
        removalActor: null,
        removalActorUserId: null,
        createdAt: DATE,
        updatedAt: DATE,
      },
      'high_roller',
    );
    expect(result).toEqual({
      id: PT_ID,
      playerId: PLAYER_ID,
      tagId: TAG_ID,
      assignReason: 'reason',
      assignActor: 'manual',
      assignActorUserId: ACTOR_ID,
      assignMetadata: null,
      removedAt: null,
      removalReason: null,
      removalActor: null,
      removalActorUserId: null,
      createdAt: ISO,
      updatedAt: ISO,
      tag: { key: 'high_roller' },
    });
  });

  it('passes removedAt Date through unchanged', () => {
    const removedAt = new Date('2024-06-01');
    const result = toPlayerTagWithTag(
      {
        id: PT_ID,
        playerId: PLAYER_ID,
        tagId: TAG_ID,
        assignReason: 'reason',
        assignActor: 'scheduled',
        assignActorUserId: null,
        assignMetadata: null,
        removedAt,
        removalReason: 'lapsed',
        removalActor: 'scheduled',
        removalActorUserId: null,
        createdAt: DATE,
        updatedAt: DATE,
      },
      'inactive',
    );
    expect(result.removedAt).toEqual(removedAt);
    expect(result.tag).toEqual({ key: 'inactive' });
  });

  it('passes a populated assignMetadata object through unchanged', () => {
    const assignMetadata = {
      amountBreach: { amount: '1500', threshold: '1000' },
      countBreach: null,
    };
    const result = toPlayerTagWithTag(
      {
        id: PT_ID,
        playerId: PLAYER_ID,
        tagId: TAG_ID,
        assignReason: 'reason',
        assignActor: 'scheduled',
        assignActorUserId: null,
        assignMetadata,
        removedAt: null,
        removalReason: null,
        removalActor: null,
        removalActorUserId: null,
        createdAt: DATE,
        updatedAt: DATE,
      },
      'high_risk',
    );
    expect(result.assignMetadata).toEqual(assignMetadata);
  });
});

describe('toTagRule', () => {
  it('converts Date fields to ISO strings and passes the decimal threshold through', () => {
    const result = toTagRule({
      id: RULE_ID,
      tagId: TAG_ID,
      tagKey: 'high_roller',
      isEnabled: true,
      threshold: '5000.50',
      thresholdDays: null,
      thresholdCount: null,
      createdAt: DATE,
      updatedAt: DATE,
    });
    expect(result).toEqual({
      id: RULE_ID,
      tagId: TAG_ID,
      tagKey: 'high_roller',
      isEnabled: true,
      threshold: '5000.50',
      thresholdDays: null,
      thresholdCount: null,
      createdAt: ISO,
      updatedAt: ISO,
    });
  });

  it('passes a null threshold through as null', () => {
    const result = toTagRule({
      id: RULE_ID,
      tagId: TAG_ID,
      tagKey: 'inactive',
      isEnabled: true,
      threshold: null,
      thresholdDays: 30,
      thresholdCount: null,
      createdAt: DATE,
      updatedAt: DATE,
    });
    expect(result.threshold).toBeNull();
    expect(result.thresholdDays).toBe(30);
  });
});
