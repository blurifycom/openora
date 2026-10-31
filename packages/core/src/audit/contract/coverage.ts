import type { DomainEventName } from '@openora/core/contracts';
import type { SUBSCRIBED_TOPICS } from './subscribed-topics.js';

type NotSubscribedTopic = Exclude<DomainEventName, (typeof SUBSCRIBED_TOPICS)[number]>;

/** Why a topic the audit subscriber skips still leaves the audit trail whole. */
export type AuditCoverage =
  | { kind: 'atSource'; writer: string; reason: string }
  | { kind: 'exempt'; reason: string };

// Every topic in `domainEventSchemas` is either in SUBSCRIBED_TOPICS (recorded by the subscriber)
// or classified here. The type is exhaustive both ways, so a new topic fails `tsc` until it is
// placed, and a topic added to SUBSCRIBED_TOPICS fails until its entry here is removed.
export const AUDIT_COVERAGE_GAPS = {
  'identity.authentication.succeeded': {
    kind: 'exempt',
    reason:
      'emitted beside identity.user.login / phone_login / 2fa.verified, which are audited; a second row would only repeat the sign-in',
  },
  'wallet.deposit.held': {
    kind: 'atSource',
    writer: 'WalletService credits the deposit via recordReconciliationFindingInTransaction',
    reason:
      'a held_deposit reconciliation finding (amount, currency, hold reason, transaction id) commits with the hold',
  },
  'wallet.withdrawal.failed': {
    kind: 'atSource',
    writer: 'WalletService.finalizeFailedWithdrawal via recordInTransaction',
    reason: 'joins the refund credit transaction; a subscription would write a second row',
  },
  'wallet.manual_adjustment.created': {
    kind: 'atSource',
    writer: 'WalletService manual adjustment via recordInTransaction',
    reason: 'joins the balance mutation, with the balance before and after',
  },
  'wallet.balance.changed': {
    kind: 'exempt',
    reason:
      'derived from a wallet_transaction ledger row on every bet, win and credit; the ledger is the record, not the audit log',
  },
  'wallet.swap.completed': {
    kind: 'atSource',
    writer: 'SwapService via recordInTransaction',
    reason: 'joins the ledger rows of both legs',
  },
  'promo.bonus.granted': {
    kind: 'atSource',
    writer: 'GrantService.grant via recordInTransaction',
    reason: 'joins the grant row and its opening ledger entry',
  },
  'promo.bonus.completed': {
    kind: 'atSource',
    writer: 'WalletCommandsService.convertBonus via recordInTransaction (promo.bonus.converted)',
    reason: 'the conversion that moves the money is audited with the balance before and after',
  },
  'promo.bonus.forfeited': {
    kind: 'atSource',
    writer: 'GrantLifecycleService.close via recordInTransaction',
    reason: 'joins the status change that takes the grant away',
  },
  'promo.bonus.expired': {
    kind: 'atSource',
    writer: 'GrantLifecycleService.close via recordInTransaction',
    reason: 'joins the status change that takes the grant away',
  },
  'promo.streak.milestone.reached': {
    kind: 'exempt',
    reason:
      'an invitation to claim, no money moves; the claim is audited by StreakPayoutService (promo.streak.milestone.claimed)',
  },
  'promo.rank.changed': {
    kind: 'atSource',
    writer: 'RankService via recordInTransaction',
    reason: 'the tier move is audited when it happens; this topic only announces it later',
  },
  'promo.race.settled': {
    kind: 'exempt',
    reason:
      'declared with no publisher; settlement is audited per payout by RacePayoutService (promo.race.payout.settled)',
  },
  'promo.race.won': {
    kind: 'atSource',
    writer: 'RacePayoutService via recordManyInTransaction (promo.race.payout.settled)',
    reason: 'joins the prize credit; this topic is the after-commit announcement',
  },
  'promo.rank-challenge.won': {
    kind: 'atSource',
    writer: 'RankChallengePayoutService via recordInTransaction (promo.rankChallenge.settled)',
    reason: 'joins the claim settlement and any cash credit; this topic is the announcement',
  },
  'chat.message.sent': {
    kind: 'exempt',
    reason:
      'one per chat message; the message row is the record and moderation actions are audited',
  },
  'chat.room.member.removed': {
    kind: 'atSource',
    writer: 'ChatRoomMembershipService and ChatContextRoomService via recordInTransaction',
    reason: 'joins the removal row; this topic is the after-commit announcement',
  },
  'chat.private_room.purged': {
    kind: 'atSource',
    writer: 'ChatRoomPurgeService via recordInTransaction',
    reason: 'written before the room is deleted, in the same transaction',
  },
  'compliance.game-geo-rules.bulk_updated': {
    kind: 'atSource',
    writer: 'ComplianceService via recordInTransaction',
    reason: 'joins the rule writes and keeps the removed rules in `before`',
  },
  'wallet.withdrawal.requeued': {
    kind: 'atSource',
    writer: 'WalletService via recordInTransaction',
    reason: 'joins the status flip back to pending; this topic is the announcement',
  },
  'sportsbook.bet.placed': {
    kind: 'atSource',
    writer: 'SportsbookLedger.announceBet via recordInTransaction',
    reason: 'joins the bet state change and its event; an align step writes sportsbook.bet.aligned instead',
  },
  'sportsbook.bet.accepted': {
    kind: 'atSource',
    writer: 'SportsbookLedger.announceBet via recordInTransaction',
    reason: 'joins the bet state change and its event; an align step writes sportsbook.bet.aligned instead',
  },
  'sportsbook.bet.cancelled': {
    kind: 'atSource',
    writer: 'SportsbookLedger.announceBet via recordInTransaction',
    reason: 'joins the bet state change and its event; an align step writes sportsbook.bet.aligned instead',
  },
  'sportsbook.bet.settled': {
    kind: 'atSource',
    writer: 'SportsbookLedger.announceBet via recordInTransaction',
    reason: 'joins the bet state change and its event; an align step writes sportsbook.bet.aligned instead',
  },
  'sportsbook.bet.reopened': {
    kind: 'atSource',
    writer: 'SportsbookLedger.announceBet via recordInTransaction',
    reason: 'joins the bet state change and its event; an align step writes sportsbook.bet.aligned instead',
  },
  'sportsbook.restriction.changed': {
    kind: 'atSource',
    writer: 'SportsbookRestriction via recordInTransaction',
    reason: 'joins the restriction write and the sessions it revokes; the event carries auditRecorded',
  },
  'sportsbook.debt.changed': {
    kind: 'atSource',
    writer: 'SportsbookDebt.writeAudit via recordInTransaction',
    reason: 'joins the debt write, last in the transaction; the event carries auditRecorded',
  },
  'player.account_manager.changed': {
    kind: 'atSource',
    writer: 'AccountManagerService via recordInTransaction (admin.player.account_manager_changed)',
    reason: 'joins the assignment write with the previous and next manager',
  },
  'support_chat.customer.linked': {
    kind: 'atSource',
    writer: 'SupportChat via recordInTransaction',
    reason: 'joins the customer link row',
  },
} as const satisfies Record<NotSubscribedTopic, AuditCoverage>;
