import type { DomainEventName } from '../schemas/events.js';
import type { ClientMeta } from '../schemas/common.js';
import { createSealedToken, type SealedToken } from './token.js';

export type DirectAuditAction =
  | 'admin.user.updated'
  | 'admin.player.updated'
  | 'admin.player.removed'
  | 'admin.player.account_manager_changed'
  | 'admin.player_note.created'
  | 'audit.export'
  | 'mail.regulatory_delivery.sent'
  | 'mail.regulatory_delivery.failed'
  | 'chat.mute.expired'
  | 'chat.platform_ban.expired'
  | 'chat.room.rule.created'
  | 'chat.room.rule.updated'
  | 'chat.room.rule.deleted'
  | 'chat.room.configuration.updated'
  | 'chat.context_room.created'
  | 'chat.context_room.member.added'
  | 'chat.context_room.member.removed'
  | 'chat.context_room.closed'
  | 'player.display_currency.set'
  | 'player.profile.updated'
  | 'player.acquisition.recorded'
  | 'player.display_decimal_places.set'
  | 'compliance.kyc.bulk_approve'
  | 'compliance.country_rule.created'
  | 'compliance.country_rule.setting_changed'
  | 'compliance.global_kyc.set'
  | 'compliance.game-geo-rules.synced'
  | 'wallet.deposit.detected'
  | 'wallet.deposit.failed'
  | 'wallet.deposit.below_minimum'
  | 'wallet.withdrawal.auto_approved'
  | 'wallet.withdrawal.outcome_unknown'
  | 'wallet.auto_withdrawal_rule.set'
  | 'wallet.auto_withdrawal_rule.deleted'
  | 'wallet.auto_withdrawal_config.set'
  | 'wallet.turnover_config.updated'
  | 'wallet.manual_adjustment.created'
  | 'wallet.withdrawal_address.created'
  | 'wallet.withdrawal_address.deleted'
  | 'wallet.custody.sweep_cycle'
  | 'wallet.custody.sweep'
  | 'wallet.reconciliation_finding.recorded'
  | 'wallet.reconciliation_finding.filled'
  | 'wallet.reconciliation_run.skipped'
  | 'wallet.reconciliation_run.completed'
  | 'wallet.reconciliation_run.failed'
  | 'wallet.ledger_invariant_run.requested'
  | 'wallet.ledger_invariant_run.skipped'
  | 'wallet.ledger_invariant_run.completed'
  | 'wallet.ledger_invariant_run.failed'
  | 'wallet.reconciliation_finding.resolved'
  | 'wallet.swap.refunded'
  | 'wallet.swap.fill_rejected'
  | 'wallet.on_ramp.checkout_requested'
  | 'wallet.on_ramp.checkout_created'
  | 'wallet.on_ramp.checkout_failed'
  | 'wallet.on_ramp.status_changed'
  | 'wallet.on_ramp.webhook_mismatch'
  | 'wallet.on_ramp.order_updated'
  | 'wallet.wallet_asset.created'
  | 'wallet.wallet_asset.updated'
  | 'wallet.wallet_asset.deleted'
  | 'promo.bonus.converted'
  | 'promo.bonus.converted_to_cash'
  | 'promo.bonus.forfeited'
  | 'promo.bonus.forfeit_refused'
  | 'promo.bonus.expired'
  | 'promo.bonus.depleted'
  | 'promo.race.payout.settled'
  | 'promo.streak.milestone.claimed'
  | 'promo.streak.milestone.expired'
  | 'promo.streak.runs_reset'
  | 'promo.offer.claimed'
  | 'promo.offer.created'
  | 'promo.offer.updated'
  | 'promo.offer.archived'
  | 'promo.weight_profile.created'
  | 'promo.weight_profile.set'
  | 'promo.rank_ladder.set'
  | 'promo.rank_ladder.installed'
  | 'promo.rank_config.set'
  | 'promo.rank_config.installed'
  | 'promo.rank_reward.claimed'
  | 'promo.rank_reward.auto_paid'
  | 'promo.rakeback.claimed'
  | 'promo.rakeback.auto_paid'
  | 'promo.rakeback.voided'
  | 'promo.rakeback.kept_on_void'
  | 'mcp.tool.invoked'
  | 'mcp.tool.failed'
  | 'mcp.action.executed'
  | 'mcp.action.failed'
  | 'iam.mcp_token.created'
  | 'iam.mcp_token.revoked'
  | 'wallet.withdrawal.held'
  | 'wallet.bet.reversed'
  | 'wallet.large_bet.recorded'
  | 'wallet.large_win.recorded'
  | 'wallet.withdrawal_hold.placed'
  | 'wallet.withdrawal_hold.released'
  | 'wallet.correction.debited'
  | 'chat.cooldown.created'
  | 'chat.cooldown.lifted'
  | 'chat.cooldown.expired'
  | 'support_chat.customer.linked'
  | 'support_chat.ticket.created'
  | 'sportsbook.config.set'
  | 'sportsbook.config.suspended'
  | 'sportsbook.config.resumed'
  | 'sportsbook.finding.resolved'
  | 'sportsbook.bet.aligned'
  | 'sportsbook.sessions.revoked';

export type AuditAction = DomainEventName | DirectAuditAction | (string & {});

type AuditEntry = {
  actorId?: string | null;
  actorType: 'player' | 'admin' | 'system';
  action: AuditAction;
  resourceType: string;
  resourceId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  correlationId?: string | null;
  result?: string | null;
} & Partial<ClientMeta>;

export type AuditWritePort = {
  readonly auditedTopics?: ReadonlySet<string>;
  record(entry: AuditEntry): Promise<void>;
  recordInTransaction(tx: unknown, entry: AuditEntry): Promise<void>;
  recordManyInTransaction(tx: unknown, entries: readonly AuditEntry[]): Promise<void>;
};

export const AUDIT_WRITER: SealedToken<AuditWritePort> =
  createSealedToken<AuditWritePort>('AUDIT_WRITER');
