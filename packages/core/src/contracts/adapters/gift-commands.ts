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
import type { ChatSystemMessage as SystemChatMessage } from './chat-system-writer.js';

export type SendGiftArgs = {
  amount: string;
  roomId: Uuid;
  idempotencyKey: Uuid;
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
  | { ok: true; message: SystemChatMessage }
  | { ok: false; reason: SendGiftFailureReason };

export type ClaimGiftFailureReason =
  | 'gift_not_found'
  | 'already_claimed'
  | 'self_claim'
  | 'room_not_member';

export type ClaimGiftResult =
  | { ok: true; claimedBy: Uuid; claimedByUsername: string; claimedAt: string }
  | { ok: false; reason: ClaimGiftFailureReason };

export type GiftCommands = {
  sendGift(input: SendGiftArgs, actorId: Uuid): Promise<SendGiftResult>;
  claimGift(giftId: Uuid, claimerId: Uuid): Promise<ClaimGiftResult>;
};

export const GIFT_COMMANDS: Token<GiftCommands> = createToken('GIFT_COMMANDS');
