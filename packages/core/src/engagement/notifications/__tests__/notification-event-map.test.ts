import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  buildChatRoomScheduledForDeletionNotification,
  buildKycResubmissionNotification,
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
    const input = entryFor('wallet.withdrawal.approved').handle({
      userId,
      amount: '10.00',
      currency: 'USD',
      transactionId,
      adminId: randomUUID(),
    });

    expect(input).toMatchObject({ userId, type: 'withdrawal.approved', data: { transactionId } });
  });

  it('maps wallet.deposit.completed to a deposit.completed notification, carrying the transaction id', () => {
    const userId = randomUUID();
    const transactionId = randomUUID();
    const input = entryFor('wallet.deposit.completed').handle({
      userId,
      amount: '25.50',
      currency: 'USD',
      transactionId,
      playerId: null,
    });

    expect(input).toMatchObject({ userId, type: 'deposit.completed', data: { transactionId } });
  });

  it('maps wallet.manual_adjustment.created to a balance.adjusted notification carrying the reason and transaction id', () => {
    const userId = randomUUID();
    const transactionId = randomUUID();
    const input = entryFor('wallet.manual_adjustment.created').handle({
      userId,
      amount: '5.00',
      currency: 'USD',
      transactionId,
      playerId: null,
      adminId: randomUUID(),
      direction: 'credit',
      reason: 'goodwill credit',
    });

    expect(input).toMatchObject({ userId, type: 'balance.adjusted', data: { transactionId } });
    expect(input?.body).toContain('goodwill credit');
  });

  it('maps chat.user.mentioned to the mentioned user, not the author, carrying room and message ids', () => {
    const byUserId = randomUUID();
    const mentionedUserId = randomUUID();
    const roomId = randomUUID();
    const messageId = randomUUID();
    const input = entryFor('chat.user.mentioned').handle({
      mentionedUserId,
      byUserId,
      roomId,
      messageId,
    });

    expect(input?.userId).toBe(mentionedUserId);
    expect(input).toMatchObject({ type: 'chat.mention', data: { roomId, messageId } });
  });

  it('carries only the message id for a global-chat mention (null roomId)', () => {
    const messageId = randomUUID();
    const input = entryFor('chat.user.mentioned').handle({
      mentionedUserId: randomUUID(),
      byUserId: randomUUID(),
      roomId: null,
      messageId,
    });

    expect(input?.data).toEqual({ messageId });
  });

  it('maps social.friend_request.sent to the requester id (who to link to)', () => {
    const requesterId = randomUUID();
    const input = entryFor('social.friend_request.sent').handle({
      friendshipId: randomUUID(),
      requesterId,
      addresseeId: randomUUID(),
      requesterUsername: 'alice',
    });

    expect(input).toMatchObject({
      type: 'social.friend_request.received',
      data: { requesterId },
    });
  });

  it('maps social.friend_request.accepted to the accepter id, not the requester (self-referential otherwise)', () => {
    const requesterId = randomUUID();
    const accepterId = randomUUID();
    const input = entryFor('social.friend_request.accepted').handle({
      friendshipId: randomUUID(),
      requesterId,
      addresseeId: randomUUID(),
      accepterId,
      accepterUsername: 'bob',
    });

    expect(input?.userId).toBe(requesterId);
    expect(input).toMatchObject({
      type: 'social.friend_request.accepted',
      data: { accepterId },
    });
  });

  it('maps chat.room.ownership.transferred to the inheriting owner, carrying the room id', () => {
    const roomId = randomUUID();
    const newOwnerId = randomUUID();
    const input = entryFor('chat.room.ownership.transferred').handle({
      roomId,
      roomName: 'Wheel Spin',
      previousOwnerId: randomUUID(),
      newOwnerId,
      reason: 'account-closed',
    });

    expect(input).toMatchObject({
      userId: newOwnerId,
      type: 'chat.room.ownership_transferred',
      data: { roomId },
    });
    expect(input!.body).toContain('Wheel Spin');
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
      data: { roomId },
    });
    expect(input.body).toContain('Wheel Spin');
    expect(input.body).toContain('30 days');
  });

  it('leaves data null for kyc.resubmission_requested (no linkable entity in the source payload)', () => {
    const input = buildKycResubmissionNotification({ userId: randomUUID(), reason: 'blurry' });

    expect(input.data).toBeNull();
  });

  it('returns null instead of throwing on a payload that fails schema validation', () => {
    const input = entryFor('wallet.withdrawal.approved').handle({ garbage: true });

    expect(input).toBeNull();
  });

  it('keeps email disabled for the pre-existing friend-request types, unchanged from before the map refactor', () => {
    expect(entryFor('social.friend_request.sent').sendEmail).toBe(false);
    expect(entryFor('social.friend_request.accepted').sendEmail).toBe(false);
  });

  it('keeps every newly-mapped trigger type in-app only (no email), per the email scope decision', () => {
    const inAppOnlyEvents = [
      'wallet.deposit.completed',
      'wallet.manual_adjustment.created',
      'wallet.withdrawal.requested',
      'wallet.withdrawal.completed',
      'wallet.withdrawal.failed',
      'chat.user.mentioned',
      'chat.room.ownership.transferred',
    ] as const;

    for (const event of inAppOnlyEvents) {
      expect(entryFor(event).sendEmail).toBe(false);
    }
  });

  it('keeps email enabled for the pre-existing withdrawal approve/reject types', () => {
    expect(entryFor('wallet.withdrawal.approved').sendEmail).toBe(true);
    expect(entryFor('wallet.withdrawal.rejected').sendEmail).toBe(true);
  });

  describe('amount formatting in notification body text', () => {
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

    it.each(events)('trims the padded 18-decimal amount down to "100" in the %s body', (event) => {
      const input = entryFor(event).handle(basePayloads[event]('100.000000000000000000'));

      expect(input?.body).toContain('100');
      expect(input?.body).not.toContain('100.000000000000000000');
    });

    it.each(events)(
      'resolves a fractional amount to "0.5", not "0.5000000000000000" or "1", in the %s body',
      (event) => {
        const input = entryFor(event).handle(basePayloads[event]('0.500000000000000000'));

        expect(input?.body).toContain('0.5');
        expect(input?.body).not.toContain('0.5000000000000000');
        expect(input?.body).not.toContain(' 1 ');
      },
    );

    it.each(events)(
      'adds a thousands separator, resolving to "1,234.5", in the %s body',
      (event) => {
        const input = entryFor(event).handle(basePayloads[event]('1234.500000000000000000'));

        expect(input?.body).toContain('1,234.5');
      },
    );

    it.each(events)(
      'does not collapse a tiny 18-decimal-scaled amount to "0" in the %s body',
      (event) => {
        const input = entryFor(event).handle(basePayloads[event]('0.000000001000000000'));

        expect(input?.body).toContain('0.000000001');
      },
    );
  });

  it('routes wallet.bonus_rollover.completed through the same amount formatter as every other entry', () => {
    const input = entryFor('wallet.bonus_rollover.completed').handle({
      userId: randomUUID(),
      creditId: randomUUID(),
      currency: 'EUR',
      creditedAmount: '1234.500000000000000000',
    });

    expect(input?.body).toContain('1,234.5');
    expect(input?.body).not.toContain('1234.500000000000000000');
  });

  it('leaves currency and reason untouched while only the amount substring is reformatted', () => {
    const input = entryFor('wallet.manual_adjustment.created').handle({
      userId: randomUUID(),
      amount: '100.000000000000000000',
      currency: 'EUR',
      transactionId: randomUUID(),
      playerId: null,
      adminId: randomUUID(),
      direction: 'credit',
      reason: 'goodwill credit',
    });

    expect(input?.body).toBe('Your balance was credited 100 EUR. Reason: goodwill credit.');
  });
});
