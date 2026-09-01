/**
 * Audit-write seam. AML/SAR audit writes are a regulator-mandated invariant under
 * MGA/UKGC - the audit module binds the sole implementation via ctx.provideSealed()
 * (bind-once, owner-only); no overlay can rebind it (ctx.provide() rejects any
 * sealed token outright, and provideSealed() itself refuses a second bind). Other
 * modules resolve this port read-only (container.get(AUDIT_WRITER)) to call it.
 */
import type { DomainEventName } from '../schemas/events.js';
import type { ClientMeta } from '../schemas/common.js';
import { createSealedToken, type SealedToken } from './token.js';

/**
 * Admin actions that are recorded directly (not via a domain-event subscription)
 * and so have no entry in `domainEventSchemas`. Add new direct actions here.
 */
export type DirectAuditAction =
  | 'admin.user.updated'
  | 'admin.player.updated'
  | 'admin.player.removed'
  | 'admin.player_note.created'
  | 'audit.export'
  // The mail worker exhausted all retries delivering a responsible-gambling or
  // KYC-resubmission email - the regulator asks about the notification at those
  // events, so a failure to send it is itself auditable. See ADR-0036.
  | 'mail.regulatory_delivery.failed'
  | 'compliance.kyc.bulk_approve'
  | 'wallet.withdrawal.auto_approved'
  | 'wallet.auto_withdrawal_rule.set'
  | 'wallet.auto_withdrawal_rule.deleted'
  | 'wallet.auto_withdrawal_config.set'
  | 'wallet.bonus_credit.created'
  | 'wallet.bonus_credit.completed'
  | 'wallet.bonus_rollover_config.set'
  | 'wallet.manual_adjustment.created'
  | 'wallet.withdrawal_address.created'
  | 'wallet.withdrawal_address.deleted'
  | 'wallet.custody.sweep_cycle'
  | 'wallet.custody.sweep'
  | 'wallet.reconciliation_finding.recorded'
  | 'wallet.reconciliation_run.skipped'
  | 'wallet.reconciliation_run.completed'
  | 'wallet.reconciliation_run.failed'
  | 'wallet.reconciliation_finding.resolved';

/**
 * Every value the audit `action` column legitimately holds: a cross-module domain
 * event topic (recorded by the audit plugin's subscriptions) or a direct admin
 * action. The `string & {}` arm keeps literal autocomplete while still accepting
 * overlay-defined actions, so it constrains nothing at runtime - it just guides.
 */
export type AuditAction = DomainEventName | DirectAuditAction | (string & {});

export type AuditWritePort = {
  record(
    entry: {
      actorId?: string | null;
      actorType: 'player' | 'admin' | 'system';
      action: AuditAction;
      resourceType: string;
      resourceId?: string | null;
      before?: Record<string, unknown> | null;
      after?: Record<string, unknown> | null;
      correlationId?: string | null;
    } & Partial<ClientMeta>,
  ): Promise<void>;
  recordInTransaction(
    tx: unknown,
    entry: {
      actorId?: string | null;
      actorType: 'player' | 'admin' | 'system';
      action: AuditAction;
      resourceType: string;
      resourceId?: string | null;
      before?: Record<string, unknown> | null;
      after?: Record<string, unknown> | null;
      correlationId?: string | null;
    } & Partial<ClientMeta>,
  ): Promise<void>;
};

export const AUDIT_WRITER: SealedToken<AuditWritePort> =
  createSealedToken<AuditWritePort>('AUDIT_WRITER');
