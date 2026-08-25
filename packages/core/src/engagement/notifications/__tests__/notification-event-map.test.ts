import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { buildKycResubmissionNotification, notificationEventMap } from '../plugin.js';

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

  it('maps chat.donate.sent to the recipient only, never the sender, carrying the room id', () => {
    const senderId = randomUUID();
    const recipientId = randomUUID();
    const roomId = randomUUID();
    const input = entryFor('chat.donate.sent').handle({
      senderId,
      senderUsername: 'alice',
      recipientId,
      recipientUsername: 'bob',
      amount: '2.00',
      currency: 'USD',
      roomId,
    });

    expect(input?.userId).toBe(recipientId);
    expect(input?.userId).not.toBe(senderId);
    expect(input).toMatchObject({ type: 'tip.received', data: { roomId } });
  });

  it('omits a null roomId from chat.donate.sent data instead of carrying a null value', () => {
    const input = entryFor('chat.donate.sent').handle({
      senderId: randomUUID(),
      senderUsername: 'alice',
      recipientId: randomUUID(),
      recipientUsername: 'bob',
      amount: '2.00',
      currency: 'USD',
      roomId: null,
    });

    expect(input?.data).toBeNull();
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

  it('leaves data null for kyc.resubmission_requested (no linkable entity in the source payload)', () => {
    const input = buildKycResubmissionNotification({ userId: randomUUID(), reason: 'blurry' });

    expect(input.data).toBeNull();
  });

  it('includes dormant gaming.bet.settled and bonus.granted mappings that never fire today, carrying their own entity ids', () => {
    const userId = randomUUID();
    const roundId = randomUUID();
    const bonusId = randomUUID();

    const betInput = entryFor('gaming.bet.settled').handle({
      roundId,
      userId,
      playerId: null,
      outcome: 'win',
      amount: '100.00',
      currency: 'USD',
    });
    const bonusInput = entryFor('bonus.granted').handle({
      bonusId,
      userId,
      amount: '10.00',
      currency: 'USD',
    });

    expect(betInput).toMatchObject({ userId, type: 'bet.settled', data: { roundId } });
    expect(bonusInput).toMatchObject({ userId, type: 'bonus.granted', data: { bonusId } });
  });

  it('returns null instead of throwing on a payload that fails schema validation', () => {
    const input = entryFor('wallet.withdrawal.approved').handle({ garbage: true });

    expect(input).toBeNull();
  });

  it('keeps email disabled for the pre-existing friend-request types, unchanged from before the map refactor', () => {
    expect(entryFor('social.friend_request.sent').sendEmail).toBe(false);
    expect(entryFor('social.friend_request.accepted').sendEmail).toBe(false);
  });

  it('enables email for every new trigger type added alongside the map, per product decision', () => {
    const emailedEvents = [
      'wallet.deposit.completed',
      'wallet.manual_adjustment.created',
      'wallet.withdrawal.requested',
      'wallet.withdrawal.completed',
      'wallet.withdrawal.failed',
      'chat.donate.sent',
      'chat.user.mentioned',
      'gaming.bet.settled',
      'bonus.granted',
    ] as const;

    for (const event of emailedEvents) {
      expect(entryFor(event).sendEmail).toBe(true);
    }
  });

  it('keeps email enabled for the pre-existing withdrawal approve/reject types', () => {
    expect(entryFor('wallet.withdrawal.approved').sendEmail).toBe(true);
    expect(entryFor('wallet.withdrawal.rejected').sendEmail).toBe(true);
  });
});
