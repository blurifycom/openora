import { describe, expect, it } from 'vitest';
import {
  ChatTransferCheckUnavailableError,
  checkChatTransfer,
  type ChatTransferCheck,
} from '../chat-transfer-check.js';
import type { ChatTransferCheckInput } from '../../schemas/chat-transfer-check.js';

const input: ChatTransferCheckInput = {
  actorId: '00000000-0000-4000-8000-000000000001',
  roomId: null,
  counterpartIds: [],
  command: 'gift',
};

const failingWith = (error: Error): ChatTransferCheck => ({
  check: async () => {
    throw error;
  },
});

describe('checkChatTransfer', () => {
  it('refuses with chat_unavailable when chat cannot answer', async () => {
    const port = failingWith(
      new ChatTransferCheckUnavailableError({ cause: new Error('timeout') }),
    );

    await expect(checkChatTransfer(port, undefined, input)).resolves.toEqual({
      allowed: false,
      refusal: 'chat_unavailable',
    });
  });

  it('lets any other fault propagate, failing the caller transaction', async () => {
    const fault = new Error('query failed');

    await expect(checkChatTransfer(failingWith(fault), undefined, input)).rejects.toBe(fault);
  });

  it('passes the verdict through', async () => {
    const port: ChatTransferCheck = {
      check: async () => ({ allowed: false, refusal: 'command_disabled' }),
    };

    await expect(checkChatTransfer(port, undefined, input)).resolves.toEqual({
      allowed: false,
      refusal: 'command_disabled',
    });
  });
});
