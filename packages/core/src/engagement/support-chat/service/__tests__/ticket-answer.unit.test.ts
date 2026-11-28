import { describe, expect, it } from 'vitest';
import { ticketIdFromAnswer } from '../support-chat.service.js';

describe('ticketIdFromAnswer', () => {
  it('reads the ticket id from a well-formed vendor answer', () => {
    expect(ticketIdFromAnswer({ ticketId: 'T-1' })).toBe('T-1');
  });

  it('returns null for an answer without a ticket id', () => {
    expect(ticketIdFromAnswer({ id: 'T-1' })).toBeNull();
  });

  it('returns null instead of throwing when a getter on the answer throws', () => {
    const answer = {
      get ticketId(): string {
        throw new Error('vendor text');
      },
    };
    expect(ticketIdFromAnswer(answer)).toBeNull();
  });
});
