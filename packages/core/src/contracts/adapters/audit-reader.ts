import type { Uuid } from '../schemas/common.js';
import { createToken, type Token } from './token.js';

export type AuditSubject = { playerId: Uuid; userId: Uuid };

export type AuditEmailChange = {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  at: Date;
  queued: boolean;
};

export type AuditReader = {
  emailChanges(subject: AuditSubject, tx?: unknown): Promise<AuditEmailChange[]>;
  othersEmailChanges(
    args: AuditSubject & { email: string },
    tx?: unknown,
  ): Promise<AuditEmailChange[]>;
};

export const AUDIT_READER: Token<AuditReader> = createToken('AUDIT_READER');
