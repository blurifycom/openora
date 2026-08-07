// Rain command port: `chat-commands` owns presence (it already depends on `chat`
// for CHAT_BLOCK_WRITER), so it resolves which players are online in a room via
// CHAT_REALTIME_TRANSPORT and hands `social-transfers` the plain id list - social-
// transfers never queries chat's presence tracking directly.
//
// Same discriminated-result shape as GIFT_COMMANDS and the same reason it
// exists: chat-commands' router can't `instanceof`-match an error class
// defined in social-transfers without a forbidden cross-module internals
// import. ADR-0017.
import { createToken, type Token } from './token.js';
import type { Uuid } from '../schemas/common.js';
import type { ChatSystemMessage } from './chat-system-writer.js';

export type SendRainArgs = {
  amount: string;
  recipientCount: number;
  // null = global chat (the GLOBAL_CHAT_ROOM_ID sentinel on the wire, contracts/schemas/chat-command.ts).
  roomId: Uuid | null;
  idempotencyKey: Uuid;
  // Every user id currently online in the room (may include the actor) -
  // resolved by the caller BEFORE this port is called. social-transfers
  // filters out the actor, shuffles, and caps to recipientCount itself.
  onlineUserIds: Uuid[];
};

export type SendRainFailureReason =
  | 'disabled'
  | 'insufficient_balance'
  | 'exceeds_limit'
  | 'below_minimum'
  | 'no_online_users'
  | 'too_many_recipients'
  | 'rain_credit_failed'
  | 'idempotency_key_reuse'
  | 'concurrent_replay'
  | 'room_not_member';

export type SendRainResult =
  | { ok: true; message: ChatSystemMessage }
  | { ok: false; reason: SendRainFailureReason };

export type RainCommands = {
  sendRain(input: SendRainArgs, actorId: Uuid): Promise<SendRainResult>;
};

export const RAIN_COMMANDS: Token<RainCommands> = createToken('RAIN_COMMANDS');
