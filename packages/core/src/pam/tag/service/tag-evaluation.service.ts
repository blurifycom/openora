import {
  domainEventSchemas,
  type WalletReader,
  type IdentityReader,
  type TagKey,
  type TagRule,
  type User,
} from '@openora/core/contracts';
import { moneyToNumber } from '@openora/core/server';
import { TagService, TagAlreadyInUseError, TagAssignmentNotFoundError } from './tag.service.js';
import { TagRuleService, TagRuleNotFoundError } from './tag-rule.service.js';

export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

const EVAL_CHUNK_SIZE = 100;

export class TagEvaluationService {
  constructor(
    private readonly tag: TagService,
    private readonly rule: TagRuleService,
    private readonly walletReader: WalletReader,
    private readonly identityReader: IdentityReader,
  ) {}

  /** Loads a rule; returns null when it does not exist or is disabled. Never throws for a missing row. */
  private async getEnabledRule(tagKey: TagKey): Promise<TagRule | null> {
    try {
      const rule = await this.rule.getTagRule(tagKey);
      if (!rule.isEnabled) return null;
      return rule;
    } catch (e) {
      if (e instanceof TagRuleNotFoundError) return null;
      throw e;
    }
  }

  /** Idempotently assigns a tag; swallows TagAlreadyInUseError. */
  private async tryAssignTag(userId: User['id'], tagKey: TagKey, reason: string) {
    const playerId = await this.identityReader.getPlayerIdByUserId(userId);
    if (!playerId) return;
    try {
      await this.tag.assignPlayerTag({
        playerId,
        tagKey,
        assignReason: reason,
        assignActor: 'scheduled',
        assignActorUserId: SYSTEM_ACTOR_ID,
      });
    } catch (e) {
      if (e instanceof TagAlreadyInUseError) return;
      throw e;
    }
  }

  /** Idempotently removes a tag; swallows TagAssignmentNotFoundError. */
  private async tryRemoveTag(userId: User['id'], tagKey: TagKey, reason: string) {
    const playerId = await this.identityReader.getPlayerIdByUserId(userId);
    if (!playerId) return;
    try {
      await this.tag.removePlayerTag({
        playerId,
        tagKey,
        removalReason: reason,
        removalActor: 'scheduled',
        removalActorUserId: SYSTEM_ACTOR_ID,
      });
    } catch (e) {
      if (e instanceof TagAssignmentNotFoundError) return;
      throw e;
    }
  }

  /**
   * Evaluates high_roller and large_depositor rules.
   * Called on wallet.deposit.completed.
   */
  async onDepositCompleted(payload: unknown) {
    const { userId, amount } = domainEventSchemas['wallet.deposit.completed'].parse(payload);

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
      await this.tryAssignTag(userId, 'large_depositor', 'single deposit crossed threshold');
    }

    if (highRoller && highRoller.threshold !== null) {
      const lifetimeDeposit = await this.walletReader.getLifetimeDeposit(userId);
      if (moneyToNumber(lifetimeDeposit) >= moneyToNumber(highRoller.threshold)) {
        await this.tryAssignTag(userId, 'high_roller', 'lifetime deposits crossed threshold');
      } else {
        await this.tryRemoveTag(userId, 'high_roller', 'lifetime deposits below threshold');
      }
    }
  }

  /**
   * Evaluates the high_risk rule based on withdrawal amount and frequency.
   * Called on wallet.withdrawal.completed.
   * Only assigns the tag when a threshold is crossed; never auto-removes
   * (risk designation requires an explicit admin clear).
   */
  async onWithdrawalCompleted(payload: unknown) {
    const { userId, amount } = domainEventSchemas['wallet.withdrawal.completed'].parse(payload);

    const rule = await this.getEnabledRule('high_risk');
    if (!rule) return;

    const amountBreached =
      rule.threshold !== null && moneyToNumber(amount) >= moneyToNumber(rule.threshold);

    let countBreached = false;
    if (rule.thresholdDays !== null && rule.thresholdCount !== null) {
      const count = await this.walletReader.getWithdrawalCountInWindow(userId, rule.thresholdDays);
      countBreached = count >= rule.thresholdCount;
    }

    if (amountBreached || countBreached) {
      await this.tryAssignTag(
        userId,
        'high_risk',
        'withdrawal amount or frequency crossed threshold',
      );
    }
  }

  /**
   * Removes the inactive tag when a player logs in.
   * Called on identity.user.login.
   */
  async onUserLogin(payload: unknown) {
    const { userId } = domainEventSchemas['identity.user.login'].parse(payload);
    await this.tryRemoveTag(userId, 'inactive', 'player logged in');
  }

  /**
   * Applies the kyc_pending tag on KYC submission and clears any prior kyc_rejected.
   * Called on compliance.kyc.submitted. Respects the kyc_pending rule's isEnabled flag.
   */
  async onKycSubmitted(payload: unknown) {
    const { userId } = domainEventSchemas['compliance.kyc.submitted'].parse(payload);
    const rule = await this.getEnabledRule('kyc_pending');
    if (!rule) return;
    await this.tryRemoveTag(userId, 'kyc_rejected', 'kyc resubmitted');
    await this.tryAssignTag(userId, 'kyc_pending', 'kyc verification initiated');
  }

  /**
   * Manages kyc_pending / kyc_rejected lifecycle on KYC status changes.
   * Called on compliance.kyc.updated. Respects the kyc_pending rule's isEnabled flag.
   *
   * Transitions:
   *   verified / manually_overridden -> remove kyc_pending + kyc_rejected
   *   rejected                       -> remove kyc_pending, assign kyc_rejected
   *   resubmission_requested         -> assign kyc_pending
   */
  async onKycStatusUpdated(payload: unknown) {
    const { userId, status } = domainEventSchemas['compliance.kyc.updated'].parse(payload);
    const rule = await this.getEnabledRule('kyc_pending');
    if (!rule) return;

    if (status === 'verified' || status === 'manually_overridden') {
      await this.tryRemoveTag(userId, 'kyc_pending', 'kyc approved');
      await this.tryRemoveTag(userId, 'kyc_rejected', 'kyc approved');
      return;
    }

    if (status === 'rejected') {
      await this.tryRemoveTag(userId, 'kyc_pending', 'kyc rejected');
      await this.tryAssignTag(userId, 'kyc_rejected', 'kyc verification rejected');
      return;
    }

    if (status === 'resubmission_requested') {
      await this.tryAssignTag(userId, 'kyc_pending', 'kyc re-verification required');
    }
  }

  /**
   * Daily scheduled evaluation: assigns inactive to players who have not logged in
   * for rule.thresholdDays days. Removal is handled by onUserLogin on next login.
   */
  async runDailyEvaluation() {
    const rule = await this.getEnabledRule('inactive');
    if (!rule || rule.thresholdDays === null) return;

    const sinceDate = new Date(Date.now() - rule.thresholdDays * 24 * 60 * 60 * 1000);
    const userIds = await this.identityReader.getPlayerIdsInactiveSince(sinceDate);

    // Chunked so the inactive-player set (unbounded) can't open one DB round-trip per
    // user or one giant Promise.all; EVAL_CHUNK_SIZE caps in-flight assignments.
    for (let i = 0; i < userIds.length; i += EVAL_CHUNK_SIZE) {
      await Promise.all(
        userIds
          .slice(i, i + EVAL_CHUNK_SIZE)
          .map((userId) =>
            this.tryAssignTag(userId, 'inactive', 'no login for configured threshold'),
          ),
      );
    }
  }
}
