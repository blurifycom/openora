import { createToken, type Token } from './token.js';
import type { EventEnvelope } from './broker.js';

export type OutboxWriter = {
  write(tx: unknown, envelope: EventEnvelope): Promise<void>;
};

export const OUTBOX: Token<OutboxWriter> = createToken('OUTBOX');
