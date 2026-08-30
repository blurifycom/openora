// Claimable-gift command port: `chat-commands` posts/claims gifts into the chat
// stream (they are conceptually part of the chat command surface) but owns none
// of the money/limit/idempotency logic - `social-transfers` does, behind this
// port. Same command-port pattern as WALLET_COMMANDS, ADR-0017. Results are a
// discriminated union rather than a thrown error so the failure reason can cross
// the module boundary without either side importing the other's error classes;
// the consuming router maps `reason` to its own typed error (see chat-commands
// AGENTS.md).
import { createToken, type Token } from './token.js';
import type { Uuid } from '../schemas/common.js';
import type { CommandChatMessage } from './chat-system-writer.js';

export type SendGiftArgs = {
  amount: string;
  // null = global chat (the GLOBAL_CHAT_ROOM_ID sentinel on the wire, contracts/schemas/chat-command.ts).
  roomId: Uuid | null;
  idempotencyKey: Uuid;
  /**
   * Which of the sender's balances to debit. Omitted, the debit falls on the sender's
   * active currency (mirrors WALLET_COMMANDS.debit's own default). Whichever currency is
   * actually debited is exactly what the claimer receives - this never routes through an
   * exchange rate, by design (see social-transfers/AGENTS.md).
   */
  currency?: string;
};

export type SendGiftFailureReason =
  | 'disabled'
  | 'insufficient_balance'
  | 'exceeds_limit'
  | 'below_minimum'
  | 'idempotency_key_reuse'
  | 'concurrent_replay'
  | 'room_not_member';

export type SendGiftResult =
  | { ok: true; message: CommandChatMessage }
  | { ok: false; reason: SendGiftFailureReason }
  | { ok: false; reason: 'player_not_found'; playerId: Uuid };

export type ClaimGiftFailureReason =
  | 'gift_not_found'
  | 'already_claimed'
  | 'self_claim'
  | 'blocked_recipient'
  | 'room_not_member'
  | 'gift_credit_failed';

export type ClaimGiftResult =
  | { ok: true; claimedBy: Uuid; claimedByUsername: string; claimedAt: string }
  // roomId is set (and only meaningful) for reason: 'room_not_member' - the gift's own
  // room, since the caller only has giftId and can't otherwise build a correct
  // ChatRoomNotMemberError (which reports a room, not a gift).
  | { ok: false; reason: ClaimGiftFailureReason; roomId?: Uuid | null };

export type GiftSnapshot = {
  id: Uuid;
  senderId: Uuid;
  senderUsername: string;
  amount: string;
  currency: string;
  claimedBy: Uuid | null;
  claimedByUsername: string | null;
  claimedAt: string | null;
  createdAt: string;
};

export type GetGiftFailureReason = 'gift_not_found' | 'room_not_member';

export type GetGiftResult =
  | { ok: true; gift: GiftSnapshot }
  // roomId mirrors ClaimGiftResult's room_not_member shape - the caller only
  // has giftId in scope and can't otherwise build a correct
  // ChatRoomNotMemberError.
  | { ok: false; reason: GetGiftFailureReason; roomId?: Uuid | null };

export type GiftCommands = {
  sendGift(input: SendGiftArgs, actorId: Uuid): Promise<SendGiftResult>;
  claimGift(giftId: Uuid, claimerId: Uuid): Promise<ClaimGiftResult>;
  getGift(giftId: Uuid, viewerId: Uuid): Promise<GetGiftResult>;
};

export const GIFT_COMMANDS: Token<GiftCommands> = createToken('GIFT_COMMANDS');
