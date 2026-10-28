import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { NOTIFICATION_PARAM_KEYS, NOTIFICATION_TYPES } from '../contract/index.js';
import {
  buildChatRoomScheduledForDeletionNotification,
  buildKycResubmissionNotification,
  buildRgLimitAdminUpdatedNotification,
  notificationEventMap,
} from '../plugin.js';

function entryFor(event: (typeof notificationEventMap)[number]['event']) {
  const entry = notificationEventMap.find((e) => e.event === event);
  if (!entry) {
    throw new Error(`no notificationEventMap entry for ${event}`);
  }
  return entry;
}

describe('notificationEventMap', () => {
  it('maps wallet.withdrawal.approved to an in-app notification for the payee, carrying the transaction id', () => {
    const userId = randomUUID();
    const transactionId = randomUUID();
    const input = entryFor('wallet.withdrawal.approved').buildNotification({
      userId,
      amount: '10.00',
      currency: 'USD',
      transactionId,
      adminId: randomUUID(),
    });

    expect(input).toEqual({
      userId,
      type: 'withdrawal.approved',
      params: { amount: '10.00', currency: 'USD' },
      data: { transactionId },
    });
  });

  it('maps wallet.deposit.completed to a deposit.completed notification, carrying the transaction id', () => {
    const userId = randomUUID();
    const transactionId = randomUUID();
    const input = entryFor('wallet.deposit.completed').buildNotification({
      userId,
      amount: '25.50',
      currency: 'USD',
      transactionId,
      playerId: null,
    });

    expect(input).toMatchObject({ userId, type: 'deposit.completed', data: { transactionId } });
  });

  it('maps wallet.manual_adjustment.created to a balance.adjusted notification carrying the transaction id, never the admin reason', () => {
    const userId = randomUUID();
    const transactionId = randomUUID();
    const input = entryFor('wallet.manual_adjustment.created').buildNotification({
      userId,
      amount: '5.00',
      currency: 'USD',
      transactionId,
      playerId: null,
      adminId: randomUUID(),
      direction: 'credit',
      reason: 'goodwill credit',
    });

    expect(input).toEqual({
      userId,
      type: 'balance.adjusted',
      params: { direction: 'credit', amount: '5.00', currency: 'USD' },
      data: { transactionId },
    });
  });

  it('maps chat.user.mentioned to the mentioned user, naming the author in params', () => {
    const mentionedUserId = randomUUID();
    const roomId = randomUUID();
    const messageId = randomUUID();
    const input = entryFor('chat.user.mentioned').buildNotification({
      mentionedUserId,
      byUserId: randomUUID(),
      byUsername: 'alice',
      roomId,
      messageId,
    });

    expect(input).toEqual({
      userId: mentionedUserId,
      type: 'chat.mention',
      params: { byUsername: 'alice' },
      data: { roomId, messageId },
    });
  });

  it('maps a chat.user.mentioned without the author username (queued before it existed) to null params', () => {
    const byUserId = randomUUID();
    const mentionedUserId = randomUUID();
    const roomId = randomUUID();
    const messageId = randomUUID();
    const input = entryFor('chat.user.mentioned').buildNotification({
      mentionedUserId,
      byUserId,
      roomId,
      messageId,
    });

    expect(input).toEqual({
      userId: mentionedUserId,
      type: 'chat.mention',
      params: null,
      data: { roomId, messageId },
    });
  });

  it('carries only the message id for a global-chat mention (null roomId)', () => {
    const messageId = randomUUID();
    const input = entryFor('chat.user.mentioned').buildNotification({
      mentionedUserId: randomUUID(),
      byUserId: randomUUID(),
      roomId: null,
      messageId,
    });

    expect(input.data).toEqual({ messageId });
  });

  it('maps social.friend_request.sent to the requester id (who to link to)', () => {
    const requesterId = randomUUID();
    const input = entryFor('social.friend_request.sent').buildNotification({
      friendshipId: randomUUID(),
      requesterId,
      addresseeId: randomUUID(),
      requesterUsername: 'alice',
    });

    expect(input).toMatchObject({
      type: 'social.friend_request.received',
      params: { requesterUsername: 'alice' },
      data: { requesterId },
    });
  });

  it('maps social.friend_request.accepted to the accepter id, not the requester (self-referential otherwise)', () => {
    const requesterId = randomUUID();
    const accepterId = randomUUID();
    const input = entryFor('social.friend_request.accepted').buildNotification({
      friendshipId: randomUUID(),
      requesterId,
      addresseeId: randomUUID(),
      accepterId,
      accepterUsername: 'bob',
    });

    expect(input.userId).toBe(requesterId);
    expect(input).toMatchObject({
      type: 'social.friend_request.accepted',
      params: { accepterUsername: 'bob' },
      data: { accepterId },
    });
  });

  it('maps chat.room.ownership.transferred to the inheriting owner, carrying the room id', () => {
    const roomId = randomUUID();
    const newOwnerId = randomUUID();
    const input = entryFor('chat.room.ownership.transferred').buildNotification({
      roomId,
      roomName: 'Wheel Spin',
      previousOwnerId: randomUUID(),
      newOwnerId,
      reason: 'account-closed',
    });

    expect(input).toMatchObject({
      userId: newOwnerId,
      type: 'chat.room.ownership_transferred',
      params: { roomName: 'Wheel Spin' },
      data: { roomId },
    });
  });

  it('builds one scheduled-for-deletion notification per member, carrying the room id', () => {
    const roomId = randomUUID();
    const userId = randomUUID();

    const input = buildChatRoomScheduledForDeletionNotification({
      userId,
      roomId,
      roomName: 'Wheel Spin',
    });

    expect(input).toMatchObject({
      userId,
      type: 'chat.room.scheduled_for_deletion',
      params: { roomName: 'Wheel Spin' },
      data: { roomId },
    });
  });

  it('leaves data null for kyc.resubmission_requested (no linkable entity in the source payload)', () => {
    const input = buildKycResubmissionNotification({ userId: randomUUID(), reason: 'blurry' });

    expect(input.data).toBeNull();
    expect(input.params).toEqual({ reason: 'blurry' });
  });

  it('leaves the reason out of a kyc.resubmission_requested notification that has none', () => {
    expect(
      buildKycResubmissionNotification({ userId: randomUUID(), reason: null }).params,
    ).toBeNull();
    expect(
      buildKycResubmissionNotification({ userId: randomUUID(), reason: '' }).params,
    ).toBeNull();
  });

  it('leaves an empty rejection reason out of a withdrawal.rejected notification', () => {
    const input = entryFor('wallet.withdrawal.rejected').buildNotification({
      userId: randomUUID(),
      amount: '10.00',
      currency: 'USD',
      transactionId: randomUUID(),
      adminId: randomUUID(),
      reason: '',
    });

    expect(input.params).toEqual({ amount: '10.00', currency: 'USD' });
  });

  describe('rg.limit.admin_updated', () => {
    const limitSet = {
      userId: randomUUID(),
      playerId: null,
      actorId: randomUUID(),
      limitId: randomUUID(),
      initiatedBy: 'admin',
      reason: 'internal case note',
    } as const;

    it('carries the limit as codes and raw values with its currency, never the admin reason', () => {
      const input = buildRgLimitAdminUpdatedNotification({
        ...limitSet,
        type: 'deposit',
        period: 'daily',
        amount: '50.000000000000000000',
        minutes: null,
        previousAmount: '100.000000000000000000',
        previousMinutes: null,
        currency: 'USDT',
      });

      expect(input).toEqual({
        userId: limitSet.userId,
        type: 'rg.limit.admin_updated',
        params: {
          period: 'daily',
          limitType: 'deposit',
          previousAmount: '100.000000000000000000',
          amount: '50.000000000000000000',
          currency: 'USDT',
        },
        data: null,
      });
      expect(JSON.stringify(input)).not.toContain('internal case note');
    });

    it('stringifies a session limit in minutes and omits a missing previous limit', () => {
      const input = buildRgLimitAdminUpdatedNotification({
        ...limitSet,
        type: 'session',
        period: 'session',
        amount: null,
        minutes: 90,
        previousAmount: null,
        previousMinutes: null,
        currency: null,
      });

      expect(input.params).toEqual({ period: 'session', limitType: 'session', minutes: '90' });
    });
  });

  it('parse returns null instead of throwing on a payload that fails schema validation', () => {
    expect(entryFor('wallet.withdrawal.approved').parse({ garbage: true })).toBeNull();
  });

  const OCCURRED_AT = '2026-01-02T03:04:05.000Z';

  it('builds no mail for the pre-existing friend-request types, unchanged from before the map refactor', () => {
    expect(entryFor('social.friend_request.sent').buildEmail({}, OCCURRED_AT)).toBeNull();
    expect(entryFor('social.friend_request.accepted').buildEmail({}, OCCURRED_AT)).toBeNull();
  });

  it('keeps every in-app-only trigger type free of email, per the email scope decision', () => {
    const inAppOnlyEvents = [
      'wallet.manual_adjustment.created',
      'chat.user.mentioned',
      'chat.room.ownership.transferred',
    ] as const;

    for (const event of inAppOnlyEvents) {
      expect(entryFor(event).buildEmail({}, OCCURRED_AT)).toBeNull();
      expect(entryFor(event).securityAlert).toBe(false);
    }
  });

  it('builds the withdrawal completed/failed mails dated from the envelope', () => {
    const payload = {
      userId: randomUUID(),
      amount: '10.00',
      currency: 'USD',
      transactionId: randomUUID(),
      adminId: null,
      playerId: null,
    };

    expect(entryFor('wallet.withdrawal.completed').buildEmail(payload, OCCURRED_AT)).toMatchObject({
      key: 'withdrawalCompleted',
      data: { amount: '10.00', currency: 'USD', occurredAt: OCCURRED_AT },
    });
    expect(entryFor('wallet.withdrawal.completed').securityAlert).toBe(false);
    expect(entryFor('wallet.withdrawal.failed').buildEmail(payload, OCCURRED_AT)).toMatchObject({
      key: 'withdrawalFailed',
      data: { amount: '10.00', currency: 'USD', occurredAt: OCCURRED_AT },
    });
    expect(entryFor('wallet.withdrawal.failed').securityAlert).toBe(false);
  });

  it('tells the player in-app and by an always-sent mail that an on-chain deposit is on hold', () => {
    const transactionId = randomUUID();
    const payload = {
      userId: randomUUID(),
      amount: '0.5',
      currency: 'BTC',
      transactionId,
      playerId: null,
    };
    const entry = entryFor('wallet.deposit.held');

    expect(entry.buildNotification(payload)).toMatchObject({
      type: 'deposit.held',
      data: { transactionId },
    });
    expect(entry.buildEmail(payload, OCCURRED_AT)).toMatchObject({
      key: 'depositHeld',
      data: { amount: '0.5', currency: 'BTC', transactionId, occurredAt: OCCURRED_AT },
    });
    expect(entry.securityAlert).toBe(false);
  });

  it('always mails the requested-withdrawal confirmation, not gated on the alert preference', () => {
    const transactionId = randomUUID();
    const payload = {
      userId: randomUUID(),
      amount: '10.00',
      currency: 'USD',
      transactionId,
    };

    const entry = entryFor('wallet.withdrawal.requested');

    expect(entry.securityAlert).toBe(false);
    expect(entry.buildEmail(payload, OCCURRED_AT)).toEqual({
      key: 'securityWithdrawalRequested',
      data: {
        amount: '10.00',
        currency: 'USD',
        transactionId,
        occurredAt: OCCURRED_AT,
      },
    });
  });

  it('builds a deposit-completed mail dated from the envelope, not the worker clock', () => {
    const userId = randomUUID();
    const transactionId = randomUUID();
    const payload = { userId, amount: '10.00', currency: 'USD', transactionId, playerId: null };

    expect(entryFor('wallet.deposit.completed').buildEmail(payload, OCCURRED_AT)).toEqual({
      key: 'depositCompleted',
      data: {
        amount: '10.00',
        currency: 'USD',
        transactionId,
        occurredAt: OCCURRED_AT,
      },
    });
  });

  it('builds a withdrawal mail dated from the envelope, not the worker clock', () => {
    const userId = randomUUID();
    const transactionId = randomUUID();
    const payload = {
      userId,
      amount: '10.00',
      currency: 'USD',
      transactionId,
      adminId: randomUUID(),
    };

    expect(entryFor('wallet.withdrawal.approved').buildEmail(payload, OCCURRED_AT)).toEqual({
      key: 'withdrawalApproved',
      data: {
        amount: '10.00',
        currency: 'USD',
        transactionId,
        occurredAt: OCCURRED_AT,
      },
    });
    expect(
      entryFor('wallet.withdrawal.rejected').buildEmail({ ...payload, reason: 'AML' }, OCCURRED_AT),
    ).toMatchObject({ key: 'withdrawalRejected', data: { reason: 'AML' } });
  });

  describe('amounts in notification params', () => {
    const basePayloads = {
      'wallet.withdrawal.approved': (amount: string) => ({
        userId: randomUUID(),
        amount,
        currency: 'EUR',
        transactionId: randomUUID(),
        adminId: randomUUID(),
      }),
      'wallet.withdrawal.rejected': (amount: string) => ({
        userId: randomUUID(),
        amount,
        currency: 'EUR',
        transactionId: randomUUID(),
        adminId: randomUUID(),
        reason: 'test reason',
      }),
      'wallet.withdrawal.requested': (amount: string) => ({
        userId: randomUUID(),
        amount,
        currency: 'EUR',
        transactionId: randomUUID(),
        playerId: null,
      }),
      'wallet.withdrawal.completed': (amount: string) => ({
        userId: randomUUID(),
        amount,
        currency: 'EUR',
        transactionId: randomUUID(),
        playerId: null,
      }),
      'wallet.withdrawal.failed': (amount: string) => ({
        userId: randomUUID(),
        amount,
        currency: 'EUR',
        transactionId: randomUUID(),
        adminId: randomUUID(),
      }),
      'wallet.deposit.completed': (amount: string) => ({
        userId: randomUUID(),
        amount,
        currency: 'EUR',
        transactionId: randomUUID(),
        playerId: null,
      }),
      'wallet.manual_adjustment.created': (amount: string) => ({
        userId: randomUUID(),
        amount,
        currency: 'EUR',
        transactionId: randomUUID(),
        playerId: null,
        adminId: randomUUID(),
        direction: 'credit' as const,
        reason: 'goodwill credit',
      }),
    } as const;

    const events = Object.keys(basePayloads) as (keyof typeof basePayloads)[];
    const amounts = [
      '100.000000000000000000',
      '0.500000000000000000',
      '1234.500000000000000000',
      '0.000000001000000000',
    ];

    it.each(events)('passes the raw event amount through to the %s params untouched', (event) => {
      for (const amount of amounts) {
        const input = entryFor(event).buildNotification(basePayloads[event](amount));

        expect(input.params).toMatchObject({ amount, currency: 'EUR' });
      }
    });
  });

  it('passes the raw converted amount of promo.bonus.completed through as its amount param', () => {
    const input = entryFor('promo.bonus.completed').buildNotification({
      userId: randomUUID(),
      grantId: randomUUID(),
      currency: 'EUR',
      convertedAmount: '1234.500000000000000000',
    });

    expect(input.params).toEqual({ amount: '1234.500000000000000000', currency: 'EUR' });
  });

  it('carries a periodic rank bonus kind and the grant source as codes', () => {
    const input = entryFor('promo.bonus.granted').buildNotification({
      userId: randomUUID(),
      grantId: randomUUID(),
      currency: 'USDT',
      grantedAmount: '10',
      wageringRequired: '10',
      source: 'rank',
      offerId: null,
      rankBonusKind: 'weekly',
    });

    expect(input.params).toEqual({
      grantedAmount: '10',
      wageringRequired: '10',
      currency: 'USDT',
      rankBonusKind: 'weekly',
      source: 'rank',
    });
  });

  describe('a bonus credit', () => {
    const granted = (source: 'deposit' | 'gift' | 'rain') => ({
      userId: randomUUID(),
      grantId: randomUUID(),
      currency: 'USDT',
      grantedAmount: '50.000000000000000000',
      wageringRequired: '1500.000000000000000000',
      source,
      offerId: null,
    });

    it('mails the credit and the wagering it obliges', () => {
      expect(entryFor('promo.bonus.granted').buildEmail(granted('deposit'), OCCURRED_AT)).toEqual({
        key: 'bonusCredited',
        data: {
          grantedAmount: '50.000000000000000000',
          wageringRequired: '1500.000000000000000000',
          currency: 'USDT',
        },
      });
    });

    it('sends no mail for a bonus another player gave, which is announced where it happened', () => {
      for (const source of ['gift', 'rain'] as const) {
        expect(entryFor('promo.bonus.granted').buildEmail(granted(source), OCCURRED_AT)).toBeNull();
      }
    });
  });

  describe('a bonus that closes without converting', () => {
    const closed = { userId: randomUUID(), grantId: randomUUID(), currency: 'USDT' };

    it('tells the player a forfeited bonus is gone, why, and how much', () => {
      const input = entryFor('promo.bonus.forfeited').buildNotification({
        ...closed,
        forfeitedAmount: '12.500000000000000000',
        reason: 'terms_breach',
        actorId: null,
      });

      expect(input).toEqual({
        userId: closed.userId,
        type: 'promo.bonus.forfeited',
        params: { amount: '12.500000000000000000', currency: 'USDT', reason: 'terms_breach' },
        data: { grantId: closed.grantId },
      });
    });

    it('tells the player an expired bonus is gone and how much', () => {
      const input = entryFor('promo.bonus.expired').buildNotification({
        ...closed,
        forfeitedAmount: '3.000000000000000000',
      });

      expect(input).toMatchObject({
        type: 'promo.bonus.expired',
        params: { amount: '3.000000000000000000', currency: 'USDT' },
        data: { grantId: closed.grantId },
      });
    });

    it('stays in-app only', () => {
      expect(entryFor('promo.bonus.forfeited').buildEmail({}, OCCURRED_AT)).toBeNull();
      expect(entryFor('promo.bonus.expired').buildEmail({}, OCCURRED_AT)).toBeNull();
    });
  });

  it('builds a bonusUnlocked mail alongside the promo.bonus.completed in-app notification', () => {
    const entry = entryFor('promo.bonus.completed');
    const payload = {
      userId: randomUUID(),
      grantId: randomUUID(),
      currency: 'EUR',
      convertedAmount: '1234.500000000000000000',
    };

    expect(entry.buildEmail(payload, OCCURRED_AT)).toEqual({
      key: 'bonusUnlocked',
      data: { convertedAmount: '1234.500000000000000000', currency: 'EUR' },
    });
    expect(entry.securityAlert).toBe(false);
  });

  it('tells the player a streak reward is waiting to be claimed', () => {
    const userId = randomUUID();

    const input = entryFor('promo.streak.milestone.reached').buildNotification({
      userId,
      day: 7,
      grantId: null,
    });

    expect(input).toEqual({
      userId,
      type: 'promo.streak.milestone.reached',
      params: { day: '7' },
      data: { day: '7' },
    });
  });

  it('tells the player how much rakeback is waiting to be claimed', () => {
    const userId = randomUUID();

    const input = entryFor('promo.rakeback.claimable').buildNotification({
      userId,
      amount: '12.5',
      currency: 'USDT',
    });

    expect(input).toEqual({
      userId,
      type: 'rakeback.claimable',
      params: { amount: '12.5', currency: 'USDT' },
      data: null,
    });
  });

  describe('promo.rank.changed', () => {
    const rankChanged = (bonuses: {
      dailyBonus: string | null;
      weeklyBonus: string | null;
      monthlyBonus: string | null;
    }) => ({
      userId: randomUUID(),
      tierId: randomUUID(),
      previousTierId: randomUUID(),
      position: 2,
      tierName: 'Gold',
      currency: 'USD',
      rakebackPercent: '5.00',
      ...bonuses,
    });

    it('carries the rank and every benefit it pays as separate raw params', () => {
      const payload = rankChanged({
        dailyBonus: '2.000000000000000000',
        weeklyBonus: '10.000000000000000000',
        monthlyBonus: '25.000000000000000000',
      });

      const input = entryFor('promo.rank.changed').buildNotification(payload);

      expect(input).toEqual({
        userId: payload.userId,
        type: 'promo.rank.changed',
        params: {
          tierName: 'Gold',
          currency: 'USD',
          rakebackPercent: '5.00',
          dailyBonus: '2.000000000000000000',
          weeklyBonus: '10.000000000000000000',
          monthlyBonus: '25.000000000000000000',
        },
        data: { tierId: payload.tierId },
      });
    });

    it('keeps delivering a notification for the original event payload', () => {
      const input = entryFor('promo.rank.changed').buildNotification({
        userId: randomUUID(),
        tierId: randomUUID(),
        previousTierId: null,
        position: 1,
      });

      expect(input).toMatchObject({ type: 'promo.rank.changed', params: null });
    });

    it('leaves out a bonus the rank does not pay', () => {
      const input = entryFor('promo.rank.changed').buildNotification(
        rankChanged({ dailyBonus: '0.500000000000000000', weeklyBonus: null, monthlyBonus: null }),
      );

      expect(input.params).toEqual({
        tierName: 'Gold',
        currency: 'USD',
        rakebackPercent: '5.00',
        dailyBonus: '0.500000000000000000',
      });
    });

    it('carries the one-off level-up bonus reaching the rank earns', () => {
      const input = entryFor('promo.rank.changed').buildNotification({
        ...rankChanged({ dailyBonus: null, weeklyBonus: null, monthlyBonus: null }),
        levelUpBonus: '50.000000000000000000',
      });

      expect(input.params).toMatchObject({ levelUpBonus: '50.000000000000000000' });
    });

    it('carries the rakeback alone when the rank pays no periodic bonus', () => {
      const input = entryFor('promo.rank.changed').buildNotification(
        rankChanged({ dailyBonus: null, weeklyBonus: null, monthlyBonus: null }),
      );

      expect(input.params).toEqual({ tierName: 'Gold', currency: 'USD', rakebackPercent: '5.00' });
    });

    it('sends no email - a rank-up is an in-app moment', () => {
      expect(
        entryFor('promo.rank.changed').buildEmail(
          rankChanged({ dailyBonus: null, weeklyBonus: null, monthlyBonus: null }),
          new Date().toISOString(),
        ),
      ).toBeNull();
    });
  });

  describe('params keys', () => {
    const id = () => randomUUID();
    const walletTxn = () => ({
      userId: id(),
      amount: '10.000000000000000000',
      currency: 'USD',
      transactionId: id(),
      playerId: null,
      adminId: id(),
    });
    // Every optional field filled, so an optional key outside the type's set would show up too.
    const payloads: Record<string, unknown> = {
      'wallet.withdrawal.approved': walletTxn(),
      'wallet.withdrawal.rejected': { ...walletTxn(), reason: 'AML' },
      'wallet.withdrawal.requested': walletTxn(),
      'wallet.withdrawal.completed': walletTxn(),
      'wallet.withdrawal.failed': walletTxn(),
      'wallet.deposit.completed': walletTxn(),
      'wallet.deposit.held': walletTxn(),
      'wallet.manual_adjustment.created': { ...walletTxn(), direction: 'debit', reason: 'fix' },
      'promo.bonus.granted': {
        userId: id(),
        grantId: id(),
        currency: 'USDT',
        grantedAmount: '10',
        wageringRequired: '300',
        source: 'rank',
        offerId: null,
        rankBonusKind: 'daily',
      },
      'promo.bonus.completed': {
        userId: id(),
        grantId: id(),
        currency: 'USDT',
        convertedAmount: '1',
      },
      'promo.bonus.forfeited': {
        userId: id(),
        grantId: id(),
        currency: 'USDT',
        forfeitedAmount: '1',
        reason: 'admin',
        actorId: id(),
      },
      'promo.bonus.expired': {
        userId: id(),
        grantId: id(),
        currency: 'USDT',
        forfeitedAmount: '1',
      },
      'promo.race.won': {
        userId: id(),
        raceId: id(),
        raceName: 'Weekly race',
        position: 3,
        amount: '25',
        currency: 'USDT',
      },
      'promo.rank-challenge.won': {
        userId: id(),
        tierId: id(),
        tierKey: 'master',
        tierName: 'Master',
        cashAmount: '500',
        physicalItem: 'Watch',
        currency: 'USDT',
      },
      'promo.rank.changed': {
        userId: id(),
        tierId: id(),
        previousTierId: id(),
        position: 4,
        tierName: 'Gold',
        currency: 'USD',
        rakebackPercent: '5.00',
        levelUpBonus: '50',
        dailyBonus: '1',
        weeklyBonus: '5',
        monthlyBonus: '20',
      },
      'promo.streak.milestone.reached': { userId: id(), day: 7, grantId: null },
      'promo.rakeback.claimable': { userId: id(), amount: '12.5', currency: 'USDT' },
      'chat.user.mentioned': {
        mentionedUserId: id(),
        byUserId: id(),
        byUsername: 'alice',
        roomId: id(),
        messageId: id(),
      },
      'chat.room.invite.sent': {
        inviteId: id(),
        roomId: id(),
        inviterId: id(),
        inviteeId: id(),
        inviterUsername: 'alice',
        roomName: 'High rollers',
        playerId: null,
      },
      'social.friend_request.sent': {
        friendshipId: id(),
        requesterId: id(),
        addresseeId: id(),
        requesterUsername: 'alice',
      },
      'social.friend_request.accepted': {
        friendshipId: id(),
        requesterId: id(),
        addresseeId: id(),
        accepterId: id(),
        accepterUsername: 'bob',
      },
      'chat.room.ownership.transferred': {
        roomId: id(),
        roomName: 'High rollers',
        previousOwnerId: id(),
        newOwnerId: id(),
        reason: 'account-closed',
      },
    };

    const coreCreated = [
      ...notificationEventMap.map((entry) => entry.buildNotification(payloads[entry.event])),
      buildKycResubmissionNotification({ userId: id(), reason: 'blurry' }),
      buildChatRoomScheduledForDeletionNotification({ userId: id(), roomId: id(), roomName: 'R' }),
      buildRgLimitAdminUpdatedNotification({
        userId: id(),
        playerId: null,
        actorId: id(),
        limitId: id(),
        type: 'deposit',
        period: 'weekly',
        amount: '10',
        minutes: null,
        previousAmount: '20',
        previousMinutes: null,
        currency: 'USD',
        initiatedBy: 'admin',
        reason: 'note',
      }),
    ];

    it('declares the keys of exactly the notification types', () => {
      expect(Object.keys(NOTIFICATION_PARAM_KEYS).sort()).toEqual([...NOTIFICATION_TYPES].sort());
    });

    // The rg fixture is a money limit, so the session-limit keys are legitimately absent.
    const absentFromFixture: Record<string, readonly string[]> = {
      'rg.limit.admin_updated': ['minutes', 'previousMinutes'],
    };

    it.each(notificationEventMap.map((entry) => [entry.event, entry] as const))(
      'uses a %s fixture the real event schema accepts',
      (event, entry) => {
        expect(entry.parse(payloads[event])).not.toBeNull();
      },
    );

    it.each(coreCreated.map((input) => [input.type, input] as const))(
      'gives a core-created %s notification, from a fully filled payload, exactly its declared keys',
      (type, input) => {
        const { required, optional } = NOTIFICATION_PARAM_KEYS[type];
        const absent = absentFromFixture[type] ?? [];
        const expected = [...required, ...optional].filter((key) => !absent.includes(key));

        expect(Object.keys(input.params ?? {}).sort()).toEqual(expected.sort());
      },
    );
  });
});
