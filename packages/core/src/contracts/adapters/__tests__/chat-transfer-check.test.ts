import { describe, expect, it, vi } from 'vitest';
import {
  ChatTransferCheckUnavailableError,
  ChatTransferRefusedError,
  checkChatTransfer,
  guardChatTransfer,
  type AllowedChatTransfer,
  type ChatTransferCheck,
} from '../chat-transfer-check.js';
import type {
  ChatTransferCheckInput,
  ChatTransferVerdict,
} from '../../schemas/chat-transfer-check.js';

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

const BLOCKED_ID = '00000000-0000-4000-8000-000000000002';

const allowed = (blockedIds: string[] = []): AllowedChatTransfer => ({
  allowed: true,
  canonicalRoomId: null,
  contextRef: null,
  blockedIds,
  commandConfig: {},
});

const answering = (...verdicts: ChatTransferVerdict[]): ChatTransferCheck => {
  const check = vi.fn<ChatTransferCheck['check']>();
  for (const verdict of verdicts) {
    check.mockResolvedValueOnce(verdict);
  }
  return { check };
};

describe('guardChatTransfer', () => {
  it('never commits when the first check refuses', async () => {
    const commit = vi.fn(async () => 'moved');

    const guarded = guardChatTransfer(
      answering({ allowed: false, refusal: 'command_disabled' }),
      undefined,
      input,
      commit,
    );

    await expect(guarded).rejects.toBeInstanceOf(ChatTransferRefusedError);
    expect(commit).not.toHaveBeenCalled();
  });

  it('throws after the commit when the second check refuses, so the caller rolls it back', async () => {
    const commit = vi.fn(async () => 'moved');

    const guarded = guardChatTransfer(
      answering(allowed(), { allowed: false, refusal: 'room_access_denied' }),
      undefined,
      input,
      commit,
    );

    await expect(guarded).rejects.toMatchObject({
      verdict: { allowed: false, refusal: 'room_access_denied' },
    });
    expect(commit).toHaveBeenCalledOnce();
  });

  it('throws when a counterpart was blocked between the checks', async () => {
    const guarded = guardChatTransfer(
      answering(allowed(), allowed([BLOCKED_ID])),
      undefined,
      input,
      async () => 'moved',
    );

    await expect(guarded).rejects.toBeInstanceOf(ChatTransferRefusedError);
  });

  it('returns the commit result when both checks allow', async () => {
    const first = allowed([BLOCKED_ID]);
    const commit = vi.fn(async () => 'moved');

    await expect(
      guardChatTransfer(answering(first, allowed([BLOCKED_ID])), undefined, input, commit),
    ).resolves.toBe('moved');
    expect(commit).toHaveBeenCalledWith(first);
  });
});
