/**
 * Audit-read seam: the audit records other modules read, so none of them imports the audit schema
 * or knows which database holds the chain. The audit module binds it.
 */
import type { Uuid } from '../schemas/common.js';
import { createToken, type Token } from './token.js';

/** The account whose records are read: its player, and its user for older records. */
export type AuditSubject = { playerId: Uuid; userId: Uuid };

/**
 * One `identity.email.changed` record: its snapshots as written, `at` when it was written,
 * `queued` while it still waits in the outbox for the chain.
 */
export type AuditEmailChange = {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  at: Date;
  queued: boolean;
};

export type AuditReader = {
  /**
   * The account's email changes, in chain order and then the ones still queued for the chain. The
   * subject is the player, or the user for a record written before the account had one. `tx` is a
   * transaction on the main database: queued records are read in it, and so is the chain when it
   * lives in the same database. A chain in its own database is read afterwards, and a queued
   * record shipped in between is kept once, in its chain place.
   */
  emailChanges(subject: AuditSubject, tx?: unknown): Promise<AuditEmailChange[]>;
  /**
   * The email changes of every other account that left or took `email`, compared
   * case-insensitively, in no order. Read like `emailChanges`.
   */
  othersEmailChanges(
    args: AuditSubject & { email: string },
    tx?: unknown,
  ): Promise<AuditEmailChange[]>;
};

export const AUDIT_READER: Token<AuditReader> = createToken('AUDIT_READER');
