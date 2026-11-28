import {
  domainEventSchemas,
  normalizeKycStatus,
  type WalletReader,
  type IdentityReader,
  type KycStatus,
  type KycTier,
  type AdminUserDirectory,
  type Player,
  type TagKey,
  type TagRule,
  type User,
} from '@openora/core/contracts';
import { moneyToNumber, mapConcurrent, createLogger } from '@openora/core/server';
import {
  TagService,
  TagAlreadyInUseError,
  TagAssignmentNotFoundError,
  TagNotFoundError,
  PlayerNotFoundError,
} from './tag.service.js';
import { TagRuleService, TagRuleNotFoundError } from './tag-rule.service.js';
import {
  SYSTEM_ACTOR_ID,
  type PlayerTagAssignMetadata,
  type HighRiskAmountBreachDetail,
  type HighRiskCountBreachDetail,
} from '@openora/core/pam/contracts/tag';

const EVAL_CHUNK_SIZE = 100;
const LAST_DEPOSIT_LOOKUP_CHUNK = 1000;
const MULTI_ACCOUNT_REASON = 'identity signal matched another player account';
const BONUS_ABUSER_REASON = 'multi-account risk rule matched';
const RECENT_DEPOSIT_REASON = 'completed a deposit';
const logger = createLogger('pam-tag-evaluation');

type TagHolder = Awaited<ReturnType<TagService['listActiveHoldersByTagKey']>>[number];
type LastDepositAts = NonNullable<WalletReader['getLastDepositAts']>;

export function isPendingKycStatus(status: KycStatus): boolean {
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
  private warnedNoLastDepositAts = false;

  constructor(deps: TagEvaluationServiceDeps) {
    this.tag = deps.tag;
    this.rule = deps.rule;
    this.walletReader = deps.walletReader;
    this.identityReader = deps.identityReader;
    this.adminUserDirectory = deps.adminUserDirectory;
  }

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

  private async tryAssignTag(args: {
    userId: User['id'];
    tagKey: TagKey;
    reason: string;
    assignMetadata?: PlayerTagAssignMetadata | null;
  }) {
    const { userId, ...assignment } = args;
    const playerId = await this.identityReader.getPlayerIdByUserId(userId);
    if (!playerId) {
      return;
    }
    await this.tryAssignPlayerTag({ playerId, ...assignment });
  }

  private async tryAssignPlayerTag(args: {
    playerId: Player['id'];
    tagKey: TagKey;
    reason: string;
    assignMetadata?: PlayerTagAssignMetadata | null;
  }) {
    const { playerId, tagKey, reason, assignMetadata } = args;
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

  private async tryRemoveTag(args: { userId: User['id']; tagKey: TagKey; reason: string }) {
    const { userId, ...removal } = args;
    const playerId = await this.identityReader.getPlayerIdByUserId(userId);
    if (!playerId) {
      return;
    }
    await this.tryRemovePlayerTag({ playerId, ...removal });
  }

  private async tryRemovePlayerTag(args: {
    playerId: Player['id'];
    tagKey: TagKey;
    reason: string;
  }) {
    const { playerId, tagKey, reason } = args;
    try {
      await this.tag.removePlayerTag({
        playerId,
        tagKey,
        removalReason: reason,
        removalActor: 'scheduled',
        removalActorUserId: SYSTEM_ACTOR_ID,
      });
    } catch (e) {
      if (e instanceof TagAssignmentNotFoundError || e instanceof TagNotFoundError) {
        return;
      }
      throw e;
    }
  }

  async onDepositCompleted(payload: unknown) {
    const parsed = domainEventSchemas['wallet.deposit.completed'].safeParse(payload);
    if (!parsed.success) {
      return;
    }
    const { userId, amount } = parsed.data;

    const [highRoller, largeDepositor, recentDepositor] = await Promise.all([
      this.getEnabledRule('high_roller'),
      this.getEnabledRule('large_depositor'),
      this.getEnabledRule('recent_depositor'),
    ]);

    if (recentDepositor && recentDepositor.thresholdDays !== null && this.lastDepositAts()) {
      await this.tryAssignTag({
        userId,
        tagKey: 'recent_depositor',
        reason: RECENT_DEPOSIT_REASON,
      });
    }

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
      if (lifetimeDeposit === null) {
        logger.warn(
          { userId },
          'onDepositCompleted: could not price lifetime deposits, skipping high_roller evaluation',
        );
      } else if (moneyToNumber(lifetimeDeposit) >= moneyToNumber(highRoller.threshold)) {
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

  private async _withdrawalReviewThresholdCrossed(amount: string): Promise<boolean> {
    const rule = await this.getEnabledRule('withdrawal_review');
    if (!rule || rule.threshold === null) {
      return false;
    }
    return moneyToNumber(amount) >= moneyToNumber(rule.threshold);
  }

  async onWithdrawalRequested(payload: unknown) {
    const parsed = domainEventSchemas['wallet.withdrawal.requested'].safeParse(payload);
    if (!parsed.success) {
      logger.error(
        { issues: parsed.error.issues },
        'malformed wallet.withdrawal.requested dropped',
      );
      return;
    }
    const { userId, amount, transactionId } = parsed.data;
    const reviewRequired = await this._withdrawalReviewThresholdCrossed(amount);
    const playerId = reviewRequired
      ? (parsed.data.playerId ?? (await this.identityReader.getPlayerIdByUserId(userId)))
      : null;
    if (reviewRequired && !playerId) {
      logger.error(
        { userId, transactionId },
        'withdrawal needs review but has no player; left unscreened',
      );
      return;
    }
    const tagged = await this.tag.screenWithdrawal({
      userId,
      transactionId,
      review: playerId
        ? {
            playerId,
            tagKey: 'withdrawal_review',
            assignReason: 'single withdrawal attempt exceeded review threshold',
            assignActor: 'scheduled',
            assignActorUserId: SYSTEM_ACTOR_ID,
          }
        : null,
    });
    if (tagged) {
      await this.evaluateBasicKycNeededOnDeposit(userId);
    }
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

  async onUserLogin(payload: unknown) {
    const parsed = domainEventSchemas['identity.user.login'].safeParse(payload);
    if (!parsed.success) {
      return;
    }
    const { userId, ip } = parsed.data;
    await this.onAuthenticatedLogin({ userId, ip });
  }

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

  async onKycSubmitted(payload: unknown) {
    const parsed = domainEventSchemas['compliance.kyc.submitted'].safeParse(payload);
    if (!parsed.success) {
      return;
    }
    const { userId, tier } = parsed.data;
    await this.removeKycNeededTag(userId, tier, 'kyc resubmitted');
    if (tier !== 'basic') {
      return;
    }
    const rule = await this.getEnabledRule('kyc_pending');
    if (!rule) {
      return;
    }
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

  private async removeKycNeededTag(userId: User['id'], tier: KycTier, reason: string) {
    const tagKey = tier === 'basic' ? 'basic_kyc_needed' : 'advanced_kyc_needed';
    const rule = await this.getEnabledRule(tagKey);
    if (rule) {
      await this.tryRemoveTag({ userId, tagKey, reason });
    }
  }

  private async evaluateBasicKycNeededOnRejection(userId: User['id']) {
    const rule = await this.getEnabledRule('basic_kyc_needed');
    if (!rule) {
      return;
    }
    const lifetimeDeposit = await this.walletReader.getLifetimeDeposit(userId);
    if (lifetimeDeposit === null || moneyToNumber(lifetimeDeposit) > 0) {
      await this.tryAssignTag({
        userId,
        tagKey: 'basic_kyc_needed',
        reason: 'kyc rejected with a completed deposit on file',
      });
    }
  }

  async onKycStatusUpdated(payload: unknown) {
    const parsed = domainEventSchemas['compliance.kyc.updated'].safeParse(payload);
    if (!parsed.success) {
      return;
    }
    const { userId, status, tier } = parsed.data;

    if (normalizeKycStatus(status) === 'approved' || status === 'manually_overridden') {
      await this.removeKycNeededTag(userId, tier, 'kyc approved');
      if (tier !== 'basic') {
        return;
      }
      await this.tryRemoveTag({ userId, tagKey: 'kyc_pending', reason: 'kyc approved' });
      await this.tryRemoveTag({ userId, tagKey: 'kyc_rejected', reason: 'kyc approved' });
      return;
    }

    if (tier !== 'basic') {
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

  async onKycUnderageDetected(payload: unknown) {
    const { userId } = domainEventSchemas['compliance.kyc.underage_detected'].parse(payload);
    const playerId = await this.identityReader.getPlayerIdByUserId(userId);
    if (!playerId) {
      throw new PlayerNotFoundError(userId);
    }
    await this.tryAssignPlayerTag({
      playerId,
      tagKey: 'age_verification_review',
      reason: 'kyc document shows the player under the minimum age',
    });
  }

  async onKycDobMismatchDetected(payload: unknown) {
    const { userId } = domainEventSchemas['compliance.kyc.dob_mismatch_detected'].parse(payload);
    await this.tryAssignTag({
      userId,
      tagKey: 'kyc_dob_mismatch',
      reason: 'kyc document date of birth differs from the declared one',
    });
  }

  async onSelfExclusionActivated(payload: unknown) {
    const { userId } = domainEventSchemas['rg.self_exclusion.activated'].parse(payload);
    await this.tryAssignTag({
      userId,
      tagKey: 'self_excluded',
      reason: 'self-exclusion activated',
    });
  }

  async onSelfExclusionLifted(payload: unknown) {
    const { userId } = domainEventSchemas['rg.self_exclusion.lifted'].parse(payload);
    await this.tryRemoveTag({ userId, tagKey: 'self_excluded', reason: 'self-exclusion lifted' });
  }

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

  async runDailyEvaluation() {
    await this._runInactiveSweep();
    await this._runDormantHighRollerSweep();
    await this._runHighRiskResweep();
    await this._runRecentDepositorSweep();
  }

  private async _runInactiveSweep() {
    const rule = await this.getEnabledRule('inactive');
    if (!rule || rule.thresholdDays === null) {
      return;
    }

    const sinceDate = new Date(Date.now() - rule.thresholdDays * 24 * 60 * 60 * 1000);
    const userIds = await this.identityReader.getPlayerIdsInactiveSince(sinceDate);

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

  private async _runRecentDepositorSweep() {
    const rule = await this.getEnabledRule('recent_depositor');
    if (!rule || rule.thresholdDays === null) {
      return;
    }
    const lastDepositAts = this.lastDepositAts();
    if (!lastDepositAts) {
      return;
    }
    const cutoff = Date.now() - rule.thresholdDays * 24 * 60 * 60 * 1000;
    const holders = await this.tag.listActiveHoldersByTagKey('recent_depositor');
    for (let start = 0; start < holders.length; start += LAST_DEPOSIT_LOOKUP_CHUNK) {
      const chunk = holders.slice(start, start + LAST_DEPOSIT_LOOKUP_CHUNK);
      await this.sweepRecentDepositors(chunk, cutoff, lastDepositAts);
    }
  }

  private async sweepRecentDepositors(
    holders: readonly TagHolder[],
    cutoff: number,
    lastDepositAts: LastDepositAts,
  ) {
    const lapsed = await this.withoutDepositSince(holders, cutoff, lastDepositAts);
    await mapConcurrent(lapsed, EVAL_CHUNK_SIZE, ({ playerId }) =>
      this.tryRemovePlayerTag({
        playerId,
        tagKey: 'recent_depositor',
        reason: 'no completed deposit within the configured window',
      }),
    );
    const stillLapsed = new Set(await this.withoutDepositSince(lapsed, cutoff, lastDepositAts));
    const depositedMeanwhile = lapsed.filter((holder) => !stillLapsed.has(holder));
    await mapConcurrent(depositedMeanwhile, EVAL_CHUNK_SIZE, ({ playerId }) =>
      this.tryAssignPlayerTag({
        playerId,
        tagKey: 'recent_depositor',
        reason: RECENT_DEPOSIT_REASON,
      }),
    );
  }

  private async withoutDepositSince(
    holders: readonly TagHolder[],
    cutoff: number,
    lastDepositAts: LastDepositAts,
  ): Promise<TagHolder[]> {
    if (holders.length === 0) {
      return [];
    }
    const ats = await lastDepositAts(holders.map((holder) => holder.userId));
    return holders.filter((holder) => (ats.get(holder.userId)?.getTime() ?? 0) < cutoff);
  }

  private lastDepositAts(): LastDepositAts | undefined {
    const read = this.walletReader.getLastDepositAts?.bind(this.walletReader);
    if (!read && !this.warnedNoLastDepositAts) {
      this.warnedNoLastDepositAts = true;
      logger.warn(
        'the bound WALLET_READER has no getLastDepositAts - recent_depositor is neither assigned nor swept',
      );
    }
    return read;
  }
}
