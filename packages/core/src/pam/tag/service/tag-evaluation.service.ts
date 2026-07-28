import {
  domainEventSchemas,
  normalizeKycStatus,
  type WalletReader,
  type IdentityReader,
  type KycStatus,
  type AdminUserDirectory,
  type TagKey,
  type TagRule,
  type User,
} from '@openora/core/contracts';
import { moneyToNumber, mapConcurrent, type DrizzleTx } from '@openora/core/server';
import { TagService, TagAlreadyInUseError, TagAssignmentNotFoundError } from './tag.service.js';
import { TagRuleService, TagRuleNotFoundError } from './tag-rule.service.js';
import type {
  PlayerTagAssignMetadata,
  HighRiskAmountBreachDetail,
  HighRiskCountBreachDetail,
} from '@openora/core/pam/contracts/tag';
import { SYSTEM_ACTOR_ID } from './tag-mappers.js';

const EVAL_CHUNK_SIZE = 100;
const MULTI_ACCOUNT_REASON = 'identity signal matched another player account';
const BONUS_ABUSER_REASON = 'multi-account risk rule matched';

function isPendingKycStatus(status: KycStatus): boolean {
  return status === 'pending' || status === 'resubmission_requested';
}

export type TagEvaluationServiceDeps = {
  tag: TagService;
  rule: TagRuleService;
  walletReader: WalletReader;
  identityReader: IdentityReader;
  adminUserDirectory: AdminUserDirectory;
};

export class TagEvaluationService {
  private readonly tag: TagService;
  private readonly rule: TagRuleService;
  private readonly walletReader: WalletReader;
  private readonly identityReader: IdentityReader;
  private readonly adminUserDirectory: AdminUserDirectory;

  constructor(deps: TagEvaluationServiceDeps) {
    this.tag = deps.tag;
    this.rule = deps.rule;
    this.walletReader = deps.walletReader;
    this.identityReader = deps.identityReader;
    this.adminUserDirectory = deps.adminUserDirectory;
  }

  /** Loads a rule; returns null when it does not exist or is disabled. Never throws for a missing row. */
  private async getEnabledRule(tagKey: TagKey): Promise<TagRule | null> {
    try {
      const rule = await this.rule.getTagRule(tagKey);
      if (!rule.isEnabled) {
        return null;
      }
      return rule;
    } catch (e) {
      if (e instanceof TagRuleNotFoundError) {
        return null;
      }
      throw e;
    }
  }

  /** Idempotently assigns a tag; swallows TagAlreadyInUseError. */
  private async tryAssignTag(args: {
    userId: User['id'];
    tagKey: TagKey;
    reason: string;
    assignMetadata?: PlayerTagAssignMetadata | null;
  }) {
    const { userId, tagKey, reason, assignMetadata } = args;
    const playerId = await this.identityReader.getPlayerIdByUserId(userId);
    if (!playerId) {
      return;
    }
    try {
      await this.tag.assignPlayerTag({
        playerId,
        tagKey,
        assignReason: reason,
        assignActor: 'scheduled',
        assignActorUserId: SYSTEM_ACTOR_ID,
        assignMetadata,
      });
    } catch (e) {
      if (e instanceof TagAlreadyInUseError) {
        return;
      }
      throw e;
    }
  }

  /** Idempotently removes a tag; swallows TagAssignmentNotFoundError. */
  private async tryRemoveTag(args: { userId: User['id']; tagKey: TagKey; reason: string }) {
    const { userId, tagKey, reason } = args;
    const playerId = await this.identityReader.getPlayerIdByUserId(userId);
    if (!playerId) {
      return;
    }
    try {
      await this.tag.removePlayerTag({
        playerId,
        tagKey,
        removalReason: reason,
        removalActor: 'scheduled',
        removalActorUserId: SYSTEM_ACTOR_ID,
      });
    } catch (e) {
      if (e instanceof TagAssignmentNotFoundError) {
        return;
      }
      throw e;
    }
  }

  /**
   * Evaluates high_roller and large_depositor rules.
   * Called on wallet.deposit.completed.
   */
  async onDepositCompleted(payload: unknown) {
    const parsed = domainEventSchemas['wallet.deposit.completed'].safeParse(payload);
    if (!parsed.success) {
      return;
    }
    const { userId, amount } = parsed.data;

    const [highRoller, largeDepositor] = await Promise.all([
      this.getEnabledRule('high_roller'),
      this.getEnabledRule('large_depositor'),
    ]);

    // Tag-threshold comparisons are evaluation decisions, not ledger writes -
    // moneyToNumber is the documented single conversion point.
    if (
      largeDepositor &&
      largeDepositor.threshold !== null &&
      moneyToNumber(amount) >= moneyToNumber(largeDepositor.threshold)
    ) {
      await this.tryAssignTag({
        userId,
        tagKey: 'large_depositor',
        reason: 'single deposit crossed threshold',
      });
    }

    if (highRoller && highRoller.threshold !== null) {
      const lifetimeDeposit = await this.walletReader.getLifetimeDeposit(userId);
      if (moneyToNumber(lifetimeDeposit) >= moneyToNumber(highRoller.threshold)) {
        await this.tryAssignTag({
          userId,
          tagKey: 'high_roller',
          reason: 'lifetime deposits crossed threshold',
        });
      } else {
        await this.tryRemoveTag({
          userId,
          tagKey: 'high_roller',
          reason: 'lifetime deposits below threshold',
        });
      }
    }
  }

  /** True when the withdrawal_review rule is enabled and amount crosses its threshold. Shared by the event path and the synchronous command-port path below so both stay in lockstep. */
  private async _withdrawalReviewThresholdCrossed(amount: string): Promise<boolean> {
    const rule = await this.getEnabledRule('withdrawal_review');
    if (!rule || rule.threshold === null) {
      return false;
    }
    return moneyToNumber(amount) >= moneyToNumber(rule.threshold);
  }

  /**
   * Assigns withdrawal_review when a single withdrawal attempt exceeds its threshold.
   * Called on wallet.withdrawal.requested (the attempt, before funds move) so the
   * review tag lands before payout. Sticky - never auto-removed here or anywhere else.
   * This is the async, best-effort fan-out path (other consumers may want the event) -
   * wallet's own auto-approval decision does NOT wait on this; it calls
   * evaluateWithdrawalRequested below instead. Idempotent with that path via
   * TagAlreadyInUseError (see tryAssignTag).
   */
  async onWithdrawalRequested(payload: unknown) {
    const { userId, amount } = domainEventSchemas['wallet.withdrawal.requested'].parse(payload);
    if (await this._withdrawalReviewThresholdCrossed(amount)) {
      await this.tryAssignTag({
        userId,
        tagKey: 'withdrawal_review',
        reason: 'single withdrawal attempt exceeded review threshold',
      });
    }
  }

  /**
   * Synchronous, transactional counterpart to onWithdrawalRequested, bound behind
   * TAG_EVALUATION_COMMANDS. wallet.withdraw() awaits this on its own transaction handle
   * BEFORE its maybeAutoApprove reads risk tags, so a withdrawal_review assignment is
   * guaranteed committed before the auto-approval decision runs - closing the race the
   * fire-and-forget EventBus emit above cannot (an EventBus emit is never awaited by the
   * emitter). Money-adjacent: never events-only for this decision (see
   * messaging-and-microservices "money never flows over events"). Any error here
   * propagates and aborts the caller's withdrawal transaction - a review-gate evaluation
   * failure must block the withdrawal rather than silently skip review.
   */
  async evaluateWithdrawalRequested(
    tx: unknown,
    args: { userId: User['id']; amount: string },
  ): Promise<void> {
    const { userId, amount } = args;
    if (!(await this._withdrawalReviewThresholdCrossed(amount))) {
      return;
    }
    const playerId = await this.identityReader.getPlayerIdByUserId(userId);
    if (!playerId) {
      return;
    }
    const trx = tx as DrizzleTx;
    try {
      await this.tag.assignPlayerTagInTx(trx, {
        playerId,
        tagKey: 'withdrawal_review',
        assignReason: 'single withdrawal attempt exceeded review threshold',
        assignActor: 'scheduled',
        assignActorUserId: SYSTEM_ACTOR_ID,
      });
    } catch (e) {
      if (e instanceof TagAlreadyInUseError) {
        return;
      }
      throw e;
    }

    await this.evaluateBasicKycNeededOnDeposit(userId);
  }

  private async evaluateBasicKycNeededOnDeposit(userId: User['id']) {
    const rule = await this.getEnabledRule('basic_kyc_needed');
    if (!rule) {
      return;
    }
    const [summary] = await this.adminUserDirectory.lookupPlayers([userId]);
    const status = summary?.kycStatus ? normalizeKycStatus(summary.kycStatus) : null;
    if (status === 'not_started' || status === 'rejected') {
      await this.tryAssignTag({
        userId,
        tagKey: 'basic_kyc_needed',
        reason: 'no approved KYC on file despite a completed deposit',
      });
    }
  }

  /**
   * Evaluates the high_risk rule based on withdrawal amount and frequency.
   * Called on wallet.withdrawal.completed. Only assigns the tag when a threshold is
   * crossed; removal is handled separately by the daily resweep in runDailyEvaluation
   * (a rolling-window count/amount can drop back under threshold with no new
   * withdrawal, so it can't be detected event-driven-only). Records which breach
   * condition(s) fired in assignMetadata - the resweep uses this to know whether the
   * amount dimension (never resweepable, see _runHighRiskResweep) was involved.
   */
  async onWithdrawalCompleted(payload: unknown) {
    const parsed = domainEventSchemas['wallet.withdrawal.completed'].safeParse(payload);
    if (!parsed.success) {
      return;
    }
    const { userId, amount } = parsed.data;

    const rule = await this.getEnabledRule('high_risk');
    if (!rule) {
      return;
    }

    const amountBreach: HighRiskAmountBreachDetail | null =
      rule.threshold !== null && moneyToNumber(amount) >= moneyToNumber(rule.threshold)
        ? { amount, threshold: rule.threshold }
        : null;

    let countBreach: HighRiskCountBreachDetail | null = null;
    if (rule.thresholdDays !== null && rule.thresholdCount !== null) {
      const count = await this.walletReader.getWithdrawalCountInWindow(userId, rule.thresholdDays);
      if (count >= rule.thresholdCount) {
        countBreach = {
          count,
          thresholdCount: rule.thresholdCount,
          thresholdDays: rule.thresholdDays,
        };
      }
    }

    if (amountBreach || countBreach) {
      await this.tryAssignTag({
        userId,
        tagKey: 'high_risk',
        reason: 'withdrawal amount or frequency crossed threshold',
        assignMetadata: { amountBreach, countBreach },
      });
    }
  }

  /**
   * Handles password login side effects:
   *  - removes inactive/dormant_high_roller on activity
   *  - assigns multi_account + bonus_abuser when another player has used this login IP
   */
  async onUserLogin(payload: unknown) {
    const parsed = domainEventSchemas['identity.user.login'].safeParse(payload);
    if (!parsed.success) {
      return;
    }
    const { userId, ip } = parsed.data;
    await this.onAuthenticatedLogin({ userId, ip });
  }

  /**
   * Phone-login path mirrors password-login risk evaluation. The signal is the same
   * authenticated session IP; the login method is intentionally not encoded in the tag.
   */
  async onUserPhoneLogin(payload: unknown) {
    const { userId, ip } = domainEventSchemas['identity.user.phone_login'].parse(payload);
    await this.onAuthenticatedLogin({ userId, ip });
  }

  private async onAuthenticatedLogin(args: { userId: User['id']; ip?: string | null }) {
    const { userId, ip } = args;
    await this.tryRemoveTag({ userId, tagKey: 'inactive', reason: 'player logged in' });
    await this.tryRemoveTag({ userId, tagKey: 'dormant_high_roller', reason: 'player logged in' });
    await this.evaluateSharedLoginIp(userId, ip);
  }

  private async evaluateSharedLoginIp(userId: User['id'], ip?: string | null) {
    const normalizedIp = ip?.trim();
    if (!normalizedIp) {
      return;
    }

    const [multiAccountRule, bonusAbuserRule] = await Promise.all([
      this.getEnabledRule('multi_account'),
      this.getEnabledRule('bonus_abuser'),
    ]);
    if (!multiAccountRule && !bonusAbuserRule) {
      return;
    }

    const linkedUserIds = await this.identityReader.getPlayerUserIdsSharingLoginIp(
      userId,
      normalizedIp,
    );
    if (linkedUserIds.length === 0) {
      return;
    }

    const userIds = [...new Set([userId, ...linkedUserIds])];
    await mapConcurrent(userIds, EVAL_CHUNK_SIZE, async (linkedUserId) => {
      if (multiAccountRule) {
        await this.tryAssignTag({
          userId: linkedUserId,
          tagKey: 'multi_account',
          reason: MULTI_ACCOUNT_REASON,
        });
      }
      if (bonusAbuserRule) {
        await this.tryAssignTag({
          userId: linkedUserId,
          tagKey: 'bonus_abuser',
          reason: BONUS_ABUSER_REASON,
        });
      }
    });
  }

  /**
   * Applies kyc_pending on KYC submission only while the profile still has a pending-like
   * status, and clears basic_kyc_needed / advanced_kyc_needed. Does not clear kyc_rejected:
   * that sticky tag remains until a later approved state explicitly clears it.
   */
  async onKycSubmitted(payload: unknown) {
    const parsed = domainEventSchemas['compliance.kyc.submitted'].safeParse(payload);
    if (!parsed.success) {
      return;
    }
    const { userId } = parsed.data;
    const rule = await this.getEnabledRule('kyc_pending');
    if (!rule) {
      return;
    }
    await this.removeKycNeededTags(userId, 'kyc resubmitted');
    const status = await this.identityReader.getPlayerKycStatusByUserId(userId);
    if (!status || !isPendingKycStatus(status)) {
      return;
    }
    await this.tryAssignTag({
      userId,
      tagKey: 'kyc_pending',
      reason: 'kyc verification initiated',
    });
  }

  private async removeKycNeededTags(userId: User['id'], reason: string) {
    for (const tagKey of ['basic_kyc_needed', 'advanced_kyc_needed'] as const) {
      const rule = await this.getEnabledRule(tagKey);
      if (rule) {
        await this.tryRemoveTag({ userId, tagKey, reason });
      }
    }
  }

  private async evaluateBasicKycNeededOnRejection(userId: User['id']) {
    const rule = await this.getEnabledRule('basic_kyc_needed');
    if (!rule) {
      return;
    }
    const lifetimeDeposit = await this.walletReader.getLifetimeDeposit(userId);
    if (moneyToNumber(lifetimeDeposit) > 0) {
      await this.tryAssignTag({
        userId,
        tagKey: 'basic_kyc_needed',
        reason: 'kyc rejected with a completed deposit on file',
      });
    }
  }

  /**
   * Manages kyc_pending / kyc_rejected / basic_kyc_needed / advanced_kyc_needed lifecycle
   * on KYC status changes. Called on compliance.kyc.updated. Assignment respects each tag
   * rule's isEnabled flag; terminal cleanup still runs so disabled rules cannot strand old
   * active rows.
   *
   * Transitions:
   *   approved / manually_overridden -> remove kyc_pending + kyc_rejected + basic_kyc_needed + advanced_kyc_needed
   *   rejected                       -> remove kyc_pending, assign kyc_rejected, evaluate basic_kyc_needed
   *   resubmission_requested         -> assign kyc_pending, keep kyc_rejected sticky
   */
  async onKycStatusUpdated(payload: unknown) {
    const parsed = domainEventSchemas['compliance.kyc.updated'].safeParse(payload);
    if (!parsed.success) {
      return;
    }
    const { userId, status } = parsed.data;

    if (normalizeKycStatus(status) === 'approved' || status === 'manually_overridden') {
      await this.tryRemoveTag({ userId, tagKey: 'kyc_pending', reason: 'kyc approved' });
      await this.tryRemoveTag({ userId, tagKey: 'kyc_rejected', reason: 'kyc approved' });
      await this.removeKycNeededTags(userId, 'kyc approved');
      return;
    }

    if (status === 'rejected') {
      await this.tryRemoveTag({ userId, tagKey: 'kyc_pending', reason: 'kyc rejected' });
      const rule = await this.getEnabledRule('kyc_rejected');
      if (rule) {
        await this.tryAssignTag({
          userId,
          tagKey: 'kyc_rejected',
          reason: 'kyc verification rejected',
        });
      }
      await this.evaluateBasicKycNeededOnRejection(userId);
      return;
    }

    if (status === 'resubmission_requested') {
      const rule = await this.getEnabledRule('kyc_pending');
      if (rule) {
        await this.tryAssignTag({
          userId,
          tagKey: 'kyc_pending',
          reason: 'kyc re-verification required',
        });
      }
    }
  }

  /**
   * Assigns advanced_kyc_needed as a pure label over compliance's own re-KYC decision.
   * Called on compliance.kyc.reverify_required. Respects the advanced_kyc_needed rule's
   * isEnabled flag.
   */
  async onKycReverifyRequired(payload: unknown) {
    const parsed = domainEventSchemas['compliance.kyc.reverify_required'].safeParse(payload);
    if (!parsed.success) {
      return;
    }
    const { userId } = parsed.data;
    const rule = await this.getEnabledRule('advanced_kyc_needed');
    if (!rule) {
      return;
    }
    await this.tryAssignTag({
      userId,
      tagKey: 'advanced_kyc_needed',
      reason: 'cumulative deposits crossed the re-KYC threshold',
    });
  }

  /**
   * Assigns high_risk as a pure label over compliance's own device/IP screening decision.
   * Called on compliance.kyc.high_risk_signal_detected. Respects the high_risk rule's
   * isEnabled flag; never auto-removes (risk designation requires an explicit admin clear).
   */
  async onKycHighRiskSignalDetected(payload: unknown) {
    const parsed =
      domainEventSchemas['compliance.kyc.high_risk_signal_detected'].safeParse(payload);
    if (!parsed.success) {
      return;
    }
    const { userId } = parsed.data;
    const rule = await this.getEnabledRule('high_risk');
    if (!rule) {
      return;
    }
    await this.tryAssignTag({
      userId,
      tagKey: 'high_risk',
      reason: 'kyc device/IP screening flagged high risk',
    });
  }

  /**
   * Assigns self_excluded when a player activates self-exclusion.
   * Called on rg.self_exclusion.activated.
   */
  async onSelfExclusionActivated(payload: unknown) {
    const { userId } = domainEventSchemas['rg.self_exclusion.activated'].parse(payload);
    await this.tryAssignTag({
      userId,
      tagKey: 'self_excluded',
      reason: 'self-exclusion activated',
    });
  }

  /**
   * Removes self_excluded when a player's self-exclusion is lifted.
   * Called on rg.self_exclusion.lifted.
   */
  async onSelfExclusionLifted(payload: unknown) {
    const { userId } = domainEventSchemas['rg.self_exclusion.lifted'].parse(payload);
    await this.tryRemoveTag({ userId, tagKey: 'self_excluded', reason: 'self-exclusion lifted' });
  }

  /**
   * Replaces the single mutable `level` tag with the player's new level.
   * Called on player.level.changed (emitted by PlayerService.update() after commit).
   * Not sticky - the level value lives only in assignReason text, never as a separate
   * tag key per level. The swap goes through TagService.replacePlayerTag: removal of
   * the prior active row (silent no-op when absent) + insert of the new one on ONE
   * transaction, so a mid-swap failure can never strand the player with the old row
   * removed and no new one committed. The loser of a concurrent replace throws
   * TagAlreadyInUseError with nothing committed - swallowed here as the usual
   * idempotent no-op (player.level itself stays the source of truth).
   */
  async onPlayerLevelChanged(payload: unknown) {
    const { userId, newLevel } = domainEventSchemas['player.level.changed'].parse(payload);
    const playerId = await this.identityReader.getPlayerIdByUserId(userId);
    if (!playerId) {
      return;
    }
    try {
      await this.tag.replacePlayerTag({
        playerId,
        tagKey: 'level',
        removalReason: 'player level changed',
        assignReason: `player level set to ${newLevel}`,
        assignActor: 'scheduled',
        assignActorUserId: SYSTEM_ACTOR_ID,
      });
    } catch (e) {
      if (e instanceof TagAlreadyInUseError) {
        return;
      }
      throw e;
    }
  }

  /**
   * Daily scheduled evaluation, three independent sweeps:
   *  - inactive: assigns to players who have not logged in for rule.thresholdDays
   *    days. Removal is handled by onUserLogin on next login.
   *  - dormant_high_roller: a co-occurrence check, not a history lookup - high_roller
   *    is only re-evaluated on deposit, so a player who goes quiet never loses it via
   *    that path. Assigns to players who are both currently inactive (per this tag's
   *    OWN thresholdDays, decoupled from the inactive rule's) and currently hold an
   *    active high_roller tag. Removal is handled by onUserLogin on next login.
   *  - high_risk resweep: removal-only, frequency dimension only. A rolling
   *    withdrawal-count window can drop back under threshold with no new withdrawal
   *    to trigger onWithdrawalCompleted, so current holders are rechecked here and
   *    removed once the count falls below threshold. Deliberately does NOT recheck
   *    the amount dimension - assignment's amount check has no time bound, so a
   *    windowed recheck would silently de-designate a still-risky player once their
   *    triggering withdrawal ages out of the window (an AML false negative). Now gated
   *    on each holder's assignMetadata (recorded at assignment): a holder whose
   *    metadata shows an amount breach is skipped regardless of their current count,
   *    and a holder with null metadata (pre-migration/legacy row, or manually
   *    assigned) is also skipped - "unknown why this was assigned" is treated as
   *    "do not auto-remove". Skipped entirely when thresholdDays or thresholdCount is
   *    null - an amount-only high_risk rule isn't resweepable by the cron; it stays
   *    until an admin clears it or a future withdrawal re-triggers assignment.
   */
  async runDailyEvaluation() {
    await this._runInactiveSweep();
    await this._runDormantHighRollerSweep();
    await this._runHighRiskResweep();
  }

  private async _runInactiveSweep() {
    const rule = await this.getEnabledRule('inactive');
    if (!rule || rule.thresholdDays === null) {
      return;
    }

    const sinceDate = new Date(Date.now() - rule.thresholdDays * 24 * 60 * 60 * 1000);
    const userIds = await this.identityReader.getPlayerIdsInactiveSince(sinceDate);

    // Capped fan-out: the inactive-player set is unbounded, so hold at most EVAL_CHUNK_SIZE
    // assignments in flight rather than one giant Promise.all that would exhaust the pool.
    await mapConcurrent(userIds, EVAL_CHUNK_SIZE, (userId) =>
      this.tryAssignTag({
        userId,
        tagKey: 'inactive',
        reason: 'no login for configured threshold',
      }),
    );
  }

  private async _runDormantHighRollerSweep() {
    const rule = await this.getEnabledRule('dormant_high_roller');
    if (!rule || rule.thresholdDays === null) {
      return;
    }

    const sinceDate = new Date(Date.now() - rule.thresholdDays * 24 * 60 * 60 * 1000);
    const inactiveUserIds = await this.identityReader.getPlayerIdsInactiveSince(sinceDate);
    const activeTagsByUser = await this.tag.getActiveTagKeys(inactiveUserIds);

    const highRollerUserIds = inactiveUserIds.filter((userId) =>
      (activeTagsByUser.get(userId) ?? []).includes('high_roller'),
    );

    await mapConcurrent(highRollerUserIds, EVAL_CHUNK_SIZE, (userId) =>
      this.tryAssignTag({
        userId,
        tagKey: 'dormant_high_roller',
        reason: 'holds high_roller and inactive for configured threshold',
      }),
    );
  }

  /**
   * Frequency-only removal. Assignment (onWithdrawalCompleted) checks a single
   * withdrawal's amount with no time bound, so an amount-only breach from outside
   * this rolling window is invisible to a windowed recheck - resweeping it would
   * silently de-designate a still-risky player (an AML false negative). Only the
   * count dimension, which IS windowed at assignment time, is safe to resweep. Each
   * holder's assignMetadata (recorded at assignment) records which breach dimension(s)
   * fired; a holder whose metadata shows an amount breach, or whose metadata is null
   * (pre-migration/legacy row or manual assignment - unknown why it was assigned), is
   * skipped regardless of their current windowed count - pinned until an admin
   * manually clears the tag or a future onWithdrawalCompleted re-evaluation populates
   * metadata. Skipped entirely when thresholdDays or thresholdCount is null - an
   * amount-only rule has no frequency dimension to resweep against and is never
   * auto-cleared by the cron, only by an admin or a future onWithdrawalCompleted
   * re-evaluation.
   */
  private async _runHighRiskResweep() {
    const rule = await this.getEnabledRule('high_risk');
    if (!rule || rule.thresholdDays === null || rule.thresholdCount === null) {
      return;
    }
    const { thresholdDays, thresholdCount } = rule;

    const holders = await this.tag.listActiveHoldersByTagKey('high_risk');
    if (holders.length === 0) {
      return;
    }
    const holderUserIds = holders.map((h) => h.userId);
    const metadataByUser = new Map(holders.map((h) => [h.userId, h.assignMetadata]));

    // One set-based query for all holders' counts, then bound only the per-user
    // removal writes - the reads are already batched, not per-row. The batched method
    // is optional on the port (an external WalletReader may predate it), so fall back to
    // bounded fan-out over the singular getWithdrawalCountInWindow when it's absent.
    const countsByUser = this.walletReader.getWithdrawalCountsInWindow
      ? await this.walletReader.getWithdrawalCountsInWindow(holderUserIds, thresholdDays)
      : new Map(
          await mapConcurrent(holderUserIds, EVAL_CHUNK_SIZE, async (userId) => {
            const count = await this.walletReader.getWithdrawalCountInWindow(userId, thresholdDays);
            return [userId, count] as const;
          }),
        );

    await mapConcurrent(holderUserIds, EVAL_CHUNK_SIZE, async (userId) => {
      const metadata = metadataByUser.get(userId) ?? null;
      if (!metadata || metadata.amountBreach) {
        return;
      }
      const countInWindow = countsByUser.get(userId) ?? 0;
      if (countInWindow < thresholdCount) {
        await this.tryRemoveTag({
          userId,
          tagKey: 'high_risk',
          reason: 'withdrawal frequency dropped below threshold within window',
        });
      }
    });
  }
}
