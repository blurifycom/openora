import { describe, it, expect, vi } from 'vitest';
import { mock } from '../../../testing/mock.js';
import type { WalletReader, IdentityReader, TagRule, KycStatus } from '@openora/core/contracts';
import { TagEvaluationService } from '../service/tag-evaluation.service.js';
import { SYSTEM_ACTOR_ID } from '../service/tag-mappers.js';
import {
  TagService,
  TagAlreadyInUseError,
  TagAssignmentNotFoundError,
} from '../service/tag.service.js';
import { TagRuleService, TagRuleNotFoundError } from '../service/tag-rule.service.js';

const UID = '11111111-1111-4111-8111-111111111111';
const TXID = '22222222-2222-4222-8222-222222222222';

function makeRule(overrides: Partial<TagRule> = {}): TagRule {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    tagId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    tagKey: 'high_roller',
    isEnabled: true,
    threshold: null,
    thresholdDays: null,
    thresholdCount: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Builds all deps. `rules` maps a tagKey to the rule row getTagRule should
 * return; an absent key makes getTagRule throw TagRuleNotFoundError (rule absent).
 */
function makeServices(rules: Partial<Record<string, TagRule>> = {}) {
  const tag = mock<TagService>({
    assignPlayerTag: vi.fn().mockResolvedValue(undefined),
    assignPlayerTagInTx: vi.fn().mockResolvedValue(undefined),
    removePlayerTag: vi.fn().mockResolvedValue(undefined),
    getActiveTagKeys: vi.fn().mockResolvedValue(new Map()),
    listActiveHoldersByTagKey: vi.fn().mockResolvedValue([]),
  });
  const rule = mock<TagRuleService>({
    getTagRule: vi.fn(async (tagKey: string) => {
      const found = rules[tagKey];
      if (!found) {
        throw new TagRuleNotFoundError(tagKey);
      }
      return found;
    }),
  });
  const walletReader = mock<WalletReader>({
    getLifetimeDeposit: vi.fn().mockResolvedValue('0'),
    getWithdrawalCountInWindow: vi.fn().mockResolvedValue(0),
    getWithdrawalCountsInWindow: vi.fn().mockResolvedValue(new Map()),
  });
  const identityReader = mock<IdentityReader>({
    getLastLoginAt: vi.fn().mockResolvedValue(null),
    getPlayerIdsInactiveSince: vi.fn().mockResolvedValue([]),
    getPlayerIdByUserId: vi.fn(async (uid: string) => uid),
  });

  const service = new TagEvaluationService(tag, rule, walletReader, identityReader);
  return { service, tag, rule, walletReader, identityReader };
}

function depositPayload(amount: number) {
  return { userId: UID, amount: String(amount), currency: 'USD', transactionId: TXID };
}
function withdrawalPayload(amount: number) {
  return { userId: UID, amount: String(amount), currency: 'USD', transactionId: TXID };
}
function kycUpdatedPayload(status: KycStatus) {
  return { userId: UID, actorId: SYSTEM_ACTOR_ID, status, previousStatus: 'pending' };
}

describe('TagEvaluationService', () => {
  describe('onDepositCompleted', () => {
    it('assigns large_depositor when a single deposit meets the amount threshold', async () => {
      const { service, tag } = makeServices({
        large_depositor: makeRule({ tagKey: 'large_depositor', threshold: '500' }),
      });
      await service.onDepositCompleted(depositPayload(500));
      expect(tag.assignPlayerTag).toHaveBeenCalledWith(
        expect.objectContaining({ playerId: UID, tagKey: 'large_depositor' }),
      );
    });

    it('does not assign large_depositor when the deposit is below threshold', async () => {
      const { service, tag } = makeServices({
        large_depositor: makeRule({ tagKey: 'large_depositor', threshold: '500' }),
      });
      await service.onDepositCompleted(depositPayload(499));
      expect(tag.assignPlayerTag).not.toHaveBeenCalled();
    });

    it('assigns high_roller when lifetime deposits meet the threshold', async () => {
      const { service, tag, walletReader } = makeServices({
        high_roller: makeRule({ tagKey: 'high_roller', threshold: '10000' }),
      });
      walletReader.getLifetimeDeposit = vi.fn().mockResolvedValue('12000');
      await service.onDepositCompleted(depositPayload(100));
      expect(tag.assignPlayerTag).toHaveBeenCalledWith(
        expect.objectContaining({ tagKey: 'high_roller' }),
      );
    });

    it('removes high_roller when lifetime deposits fall below a raised threshold', async () => {
      const { service, tag, walletReader } = makeServices({
        high_roller: makeRule({ tagKey: 'high_roller', threshold: '10000' }),
      });
      walletReader.getLifetimeDeposit = vi.fn().mockResolvedValue('5000');
      await service.onDepositCompleted(depositPayload(100));
      expect(tag.removePlayerTag).toHaveBeenCalledWith(
        expect.objectContaining({ tagKey: 'high_roller' }),
      );
      expect(tag.assignPlayerTag).not.toHaveBeenCalled();
    });

    it('does nothing when the rules are disabled', async () => {
      const { service, tag, walletReader } = makeServices({
        high_roller: makeRule({ tagKey: 'high_roller', threshold: '10000', isEnabled: false }),
        large_depositor: makeRule({
          tagKey: 'large_depositor',
          threshold: '100',
          isEnabled: false,
        }),
      });
      await service.onDepositCompleted(depositPayload(99999));
      expect(tag.assignPlayerTag).not.toHaveBeenCalled();
      expect(tag.removePlayerTag).not.toHaveBeenCalled();
      expect(walletReader.getLifetimeDeposit).not.toHaveBeenCalled();
    });
  });

  describe('onWithdrawalCompleted', () => {
    it('assigns high_risk when a single withdrawal meets the amount threshold, recording the amount breach detail', async () => {
      const { service, tag } = makeServices({
        high_risk: makeRule({ tagKey: 'high_risk', threshold: '1000' }),
      });
      await service.onWithdrawalCompleted(withdrawalPayload(1500));
      expect(tag.assignPlayerTag).toHaveBeenCalledWith(
        expect.objectContaining({
          tagKey: 'high_risk',
          assignMetadata: {
            amountBreach: { amount: '1500', threshold: '1000' },
            countBreach: null,
          },
        }),
      );
    });

    it('assigns high_risk when the withdrawal count in the window meets the threshold, recording the count breach detail', async () => {
      const { service, tag, walletReader } = makeServices({
        high_risk: makeRule({
          tagKey: 'high_risk',
          threshold: '1000',
          thresholdDays: 7,
          thresholdCount: 3,
        }),
      });
      walletReader.getWithdrawalCountInWindow = vi.fn().mockResolvedValue(3);
      await service.onWithdrawalCompleted(withdrawalPayload(10));
      expect(walletReader.getWithdrawalCountInWindow).toHaveBeenCalledWith(UID, 7);
      expect(tag.assignPlayerTag).toHaveBeenCalledWith(
        expect.objectContaining({
          tagKey: 'high_risk',
          assignMetadata: {
            amountBreach: null,
            countBreach: { count: 3, thresholdCount: 3, thresholdDays: 7 },
          },
        }),
      );
    });

    it('records both breach details when both amount and frequency thresholds are met', async () => {
      const { service, tag, walletReader } = makeServices({
        high_risk: makeRule({
          tagKey: 'high_risk',
          threshold: '1000',
          thresholdDays: 7,
          thresholdCount: 3,
        }),
      });
      walletReader.getWithdrawalCountInWindow = vi.fn().mockResolvedValue(5);
      await service.onWithdrawalCompleted(withdrawalPayload(1500));
      expect(tag.assignPlayerTag).toHaveBeenCalledWith(
        expect.objectContaining({
          tagKey: 'high_risk',
          assignMetadata: {
            amountBreach: { amount: '1500', threshold: '1000' },
            countBreach: { count: 5, thresholdCount: 3, thresholdDays: 7 },
          },
        }),
      );
    });

    it('takes no action when neither threshold is met (risk designation requires admin clear)', async () => {
      const { service, tag, walletReader } = makeServices({
        high_risk: makeRule({
          tagKey: 'high_risk',
          threshold: '1000',
          thresholdDays: 7,
          thresholdCount: 3,
        }),
      });
      walletReader.getWithdrawalCountInWindow = vi.fn().mockResolvedValue(1);
      await service.onWithdrawalCompleted(withdrawalPayload(10));
      expect(tag.assignPlayerTag).not.toHaveBeenCalled();
      expect(tag.removePlayerTag).not.toHaveBeenCalled();
    });

    it('skips the count check when thresholdDays or thresholdCount is null', async () => {
      const { service, walletReader } = makeServices({
        high_risk: makeRule({ tagKey: 'high_risk', threshold: '1000', thresholdDays: null }),
      });
      await service.onWithdrawalCompleted(withdrawalPayload(10));
      expect(walletReader.getWithdrawalCountInWindow).not.toHaveBeenCalled();
    });
  });

  describe('onWithdrawalRequested', () => {
    it('assigns withdrawal_review when the withdrawal amount meets the threshold', async () => {
      const { service, tag } = makeServices({
        withdrawal_review: makeRule({ tagKey: 'withdrawal_review', threshold: '5000' }),
      });
      await service.onWithdrawalRequested(withdrawalPayload(5000));
      expect(tag.assignPlayerTag).toHaveBeenCalledWith(
        expect.objectContaining({ playerId: UID, tagKey: 'withdrawal_review' }),
      );
    });

    it('does not assign withdrawal_review when the amount is below threshold', async () => {
      const { service, tag } = makeServices({
        withdrawal_review: makeRule({ tagKey: 'withdrawal_review', threshold: '5000' }),
      });
      await service.onWithdrawalRequested(withdrawalPayload(4999));
      expect(tag.assignPlayerTag).not.toHaveBeenCalled();
    });

    it('does nothing when the rule is disabled', async () => {
      const { service, tag } = makeServices({
        withdrawal_review: makeRule({
          tagKey: 'withdrawal_review',
          threshold: '5000',
          isEnabled: false,
        }),
      });
      await service.onWithdrawalRequested(withdrawalPayload(99999));
      expect(tag.assignPlayerTag).not.toHaveBeenCalled();
    });

    it('does nothing when the rule is absent', async () => {
      const { service, tag } = makeServices();
      await service.onWithdrawalRequested(withdrawalPayload(99999));
      expect(tag.assignPlayerTag).not.toHaveBeenCalled();
    });
  });

  describe('evaluateWithdrawalRequested (synchronous TAG_EVALUATION_COMMANDS path)', () => {
    const FAKE_TX = { fake: 'tx-handle' };

    it('assigns withdrawal_review on the caller-supplied tx (not assignPlayerTag) when the amount meets threshold', async () => {
      const { service, tag } = makeServices({
        withdrawal_review: makeRule({ tagKey: 'withdrawal_review', threshold: '5000' }),
      });
      await service.evaluateWithdrawalRequested(FAKE_TX, { userId: UID, amount: '5000' });
      expect(tag.assignPlayerTagInTx).toHaveBeenCalledWith(
        FAKE_TX,
        expect.objectContaining({ playerId: UID, tagKey: 'withdrawal_review' }),
      );
      expect(tag.assignPlayerTag).not.toHaveBeenCalled();
    });

    it('does not assign when the amount is below threshold', async () => {
      const { service, tag } = makeServices({
        withdrawal_review: makeRule({ tagKey: 'withdrawal_review', threshold: '5000' }),
      });
      await service.evaluateWithdrawalRequested(FAKE_TX, { userId: UID, amount: '4999' });
      expect(tag.assignPlayerTagInTx).not.toHaveBeenCalled();
    });

    it('does nothing when the rule is disabled or absent', async () => {
      const { service, tag } = makeServices();
      await service.evaluateWithdrawalRequested(FAKE_TX, { userId: UID, amount: '99999' });
      expect(tag.assignPlayerTagInTx).not.toHaveBeenCalled();
    });

    it('is idempotent - swallows TagAlreadyInUseError when already assigned', async () => {
      const { service, tag } = makeServices({
        withdrawal_review: makeRule({ tagKey: 'withdrawal_review', threshold: '5000' }),
      });
      tag.assignPlayerTagInTx = vi.fn().mockRejectedValue(new TagAlreadyInUseError());
      await expect(
        service.evaluateWithdrawalRequested(FAKE_TX, { userId: UID, amount: '5000' }),
      ).resolves.toBeUndefined();
    });

    it('propagates an unexpected error (fail-closed: a review-gate failure must block the caller, not silently skip review)', async () => {
      const { service, tag } = makeServices({
        withdrawal_review: makeRule({ tagKey: 'withdrawal_review', threshold: '5000' }),
      });
      const dbError = new Error('db unavailable');
      tag.assignPlayerTagInTx = vi.fn().mockRejectedValue(dbError);
      await expect(
        service.evaluateWithdrawalRequested(FAKE_TX, { userId: UID, amount: '5000' }),
      ).rejects.toBe(dbError);
    });
  });

  describe('onUserLogin', () => {
    it('tries to remove the inactive tag', async () => {
      const { service, tag } = makeServices();
      await service.onUserLogin({ userId: UID });
      expect(tag.removePlayerTag).toHaveBeenCalledWith(
        expect.objectContaining({ playerId: UID, tagKey: 'inactive', removalActor: 'scheduled' }),
      );
    });

    it('also tries to remove the dormant_high_roller tag', async () => {
      const { service, tag } = makeServices();
      await service.onUserLogin({ userId: UID });
      expect(tag.removePlayerTag).toHaveBeenCalledWith(
        expect.objectContaining({
          playerId: UID,
          tagKey: 'dormant_high_roller',
          removalActor: 'scheduled',
        }),
      );
    });

    it('is idempotent when dormant_high_roller was never assigned', async () => {
      const { service, tag } = makeServices();
      tag.removePlayerTag = vi.fn().mockRejectedValue(new TagAssignmentNotFoundError(UID));
      await expect(service.onUserLogin({ userId: UID })).resolves.toBeUndefined();
    });
  });

  describe('onKycSubmitted', () => {
    const kycRule = { kyc_pending: makeRule({ tagKey: 'kyc_pending' }) };

    it('assigns kyc_pending when the rule is enabled', async () => {
      const { service, tag } = makeServices(kycRule);
      await service.onKycSubmitted({ userId: UID, referenceId: 'ref-1', provider: 'sumsub' });
      expect(tag.assignPlayerTag).toHaveBeenCalledWith(
        expect.objectContaining({ tagKey: 'kyc_pending' }),
      );
    });

    it('also tries to remove kyc_rejected on the resubmission path', async () => {
      const { service, tag } = makeServices(kycRule);
      await service.onKycSubmitted({ userId: UID, referenceId: 'ref-1', provider: 'sumsub' });
      expect(tag.removePlayerTag).toHaveBeenCalledWith(
        expect.objectContaining({ tagKey: 'kyc_rejected' }),
      );
    });

    it('does nothing when kyc_pending rule is disabled', async () => {
      const { service, tag } = makeServices({
        kyc_pending: makeRule({ tagKey: 'kyc_pending', isEnabled: false }),
      });
      await service.onKycSubmitted({ userId: UID, referenceId: 'ref-1', provider: 'sumsub' });
      expect(tag.assignPlayerTag).not.toHaveBeenCalled();
    });

    it('is idempotent when kyc_pending is already assigned (at-least-once delivery)', async () => {
      const { service, tag } = makeServices(kycRule);
      tag.assignPlayerTag = vi.fn().mockRejectedValue(new TagAlreadyInUseError());
      await expect(
        service.onKycSubmitted({ userId: UID, referenceId: 'ref-1', provider: 'sumsub' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('onKycStatusUpdated', () => {
    const kycRule = { kyc_pending: makeRule({ tagKey: 'kyc_pending' }) };

    it('removes kyc_pending on verified', async () => {
      const { service, tag } = makeServices(kycRule);
      await service.onKycStatusUpdated(kycUpdatedPayload('verified'));
      expect(tag.removePlayerTag).toHaveBeenCalledWith(
        expect.objectContaining({ tagKey: 'kyc_pending' }),
      );
      expect(tag.assignPlayerTag).not.toHaveBeenCalled();
    });

    it('removes kyc_pending and assigns kyc_rejected on rejected', async () => {
      const { service, tag } = makeServices(kycRule);
      await service.onKycStatusUpdated(kycUpdatedPayload('rejected'));
      expect(tag.removePlayerTag).toHaveBeenCalledWith(
        expect.objectContaining({ tagKey: 'kyc_pending' }),
      );
      expect(tag.assignPlayerTag).toHaveBeenCalledWith(
        expect.objectContaining({ tagKey: 'kyc_rejected' }),
      );
    });

    it('assigns kyc_pending on resubmission_requested', async () => {
      const { service, tag } = makeServices(kycRule);
      await service.onKycStatusUpdated(kycUpdatedPayload('resubmission_requested'));
      expect(tag.assignPlayerTag).toHaveBeenCalledWith(
        expect.objectContaining({ tagKey: 'kyc_pending' }),
      );
    });

    it('does nothing when kyc_pending rule is disabled', async () => {
      const { service, tag } = makeServices({
        kyc_pending: makeRule({ tagKey: 'kyc_pending', isEnabled: false }),
      });
      await service.onKycStatusUpdated(kycUpdatedPayload('verified'));
      expect(tag.removePlayerTag).not.toHaveBeenCalled();
    });

    it('is idempotent when verified fires twice (tags already removed)', async () => {
      const { service, tag } = makeServices(kycRule);
      tag.removePlayerTag = vi.fn().mockRejectedValue(new TagAssignmentNotFoundError(UID));
      await expect(
        service.onKycStatusUpdated(kycUpdatedPayload('verified')),
      ).resolves.toBeUndefined();
    });

    it('is idempotent when rejected fires twice (kyc_pending gone, kyc_rejected already present)', async () => {
      const { service, tag } = makeServices(kycRule);
      tag.removePlayerTag = vi.fn().mockRejectedValue(new TagAssignmentNotFoundError(UID));
      tag.assignPlayerTag = vi.fn().mockRejectedValue(new TagAlreadyInUseError());
      await expect(
        service.onKycStatusUpdated(kycUpdatedPayload('rejected')),
      ).resolves.toBeUndefined();
    });

    it('is idempotent when resubmission_requested fires twice (kyc_pending already assigned)', async () => {
      const { service, tag } = makeServices(kycRule);
      tag.assignPlayerTag = vi.fn().mockRejectedValue(new TagAlreadyInUseError());
      await expect(
        service.onKycStatusUpdated(kycUpdatedPayload('resubmission_requested')),
      ).resolves.toBeUndefined();
    });
  });

  describe('runDailyEvaluation', () => {
    it('assigns inactive to each player returned by the identity reader', async () => {
      const { service, tag, identityReader } = makeServices({
        inactive: makeRule({ tagKey: 'inactive', thresholdDays: 30 }),
      });
      identityReader.getPlayerIdsInactiveSince = vi.fn().mockResolvedValue(['p1', 'p2']);
      await service.runDailyEvaluation();
      expect(tag.assignPlayerTag).toHaveBeenCalledTimes(2);
      expect(tag.assignPlayerTag).toHaveBeenCalledWith(
        expect.objectContaining({ playerId: 'p1', tagKey: 'inactive' }),
      );
      expect(tag.assignPlayerTag).toHaveBeenCalledWith(
        expect.objectContaining({ playerId: 'p2', tagKey: 'inactive' }),
      );
    });

    it('returns early when the rule is disabled', async () => {
      const { service, identityReader } = makeServices({
        inactive: makeRule({ tagKey: 'inactive', thresholdDays: 30, isEnabled: false }),
      });
      await service.runDailyEvaluation();
      expect(identityReader.getPlayerIdsInactiveSince).not.toHaveBeenCalled();
    });

    it('returns early when thresholdDays is null', async () => {
      const { service, identityReader } = makeServices({
        inactive: makeRule({ tagKey: 'inactive', thresholdDays: null }),
      });
      await service.runDailyEvaluation();
      expect(identityReader.getPlayerIdsInactiveSince).not.toHaveBeenCalled();
    });

    describe('dormant_high_roller sweep', () => {
      it('assigns to inactive users who also hold high_roller', async () => {
        const { service, tag, identityReader } = makeServices({
          dormant_high_roller: makeRule({ tagKey: 'dormant_high_roller', thresholdDays: 60 }),
        });
        identityReader.getPlayerIdsInactiveSince = vi.fn().mockResolvedValue(['p1', 'p2']);
        tag.getActiveTagKeys = vi.fn().mockResolvedValue(
          new Map([
            ['p1', ['high_roller']],
            ['p2', ['kyc_pending']],
          ]),
        );
        await service.runDailyEvaluation();
        expect(tag.assignPlayerTag).toHaveBeenCalledWith(
          expect.objectContaining({ playerId: 'p1', tagKey: 'dormant_high_roller' }),
        );
        expect(tag.assignPlayerTag).not.toHaveBeenCalledWith(
          expect.objectContaining({ playerId: 'p2', tagKey: 'dormant_high_roller' }),
        );
      });

      it('does not assign to inactive users without high_roller', async () => {
        const { service, tag, identityReader } = makeServices({
          dormant_high_roller: makeRule({ tagKey: 'dormant_high_roller', thresholdDays: 60 }),
        });
        identityReader.getPlayerIdsInactiveSince = vi.fn().mockResolvedValue(['p1']);
        tag.getActiveTagKeys = vi.fn().mockResolvedValue(new Map([['p1', ['vip']]]));
        await service.runDailyEvaluation();
        expect(tag.assignPlayerTag).not.toHaveBeenCalledWith(
          expect.objectContaining({ tagKey: 'dormant_high_roller' }),
        );
      });

      it('does nothing when the rule is disabled', async () => {
        const { service, identityReader } = makeServices({
          dormant_high_roller: makeRule({
            tagKey: 'dormant_high_roller',
            thresholdDays: 60,
            isEnabled: false,
          }),
        });
        await service.runDailyEvaluation();
        expect(identityReader.getPlayerIdsInactiveSince).not.toHaveBeenCalled();
      });

      it('does nothing when thresholdDays is null', async () => {
        const { service, tag } = makeServices({
          dormant_high_roller: makeRule({ tagKey: 'dormant_high_roller', thresholdDays: null }),
        });
        await service.runDailyEvaluation();
        expect(tag.getActiveTagKeys).not.toHaveBeenCalled();
      });
    });

    describe('high_risk resweep', () => {
      const countOnlyMetadata = {
        amountBreach: null,
        countBreach: { count: 3, thresholdCount: 3, thresholdDays: 7 },
      };
      const amountBreachMetadata = {
        amountBreach: { amount: '2000', threshold: '1000' },
        countBreach: null,
      };

      it('removes the tag from a holder when the recheck shows count below threshold', async () => {
        const { service, tag, walletReader } = makeServices({
          high_risk: makeRule({
            tagKey: 'high_risk',
            threshold: '1000',
            thresholdDays: 7,
            thresholdCount: 3,
          }),
        });
        tag.listActiveHoldersByTagKey = vi
          .fn()
          .mockResolvedValue([{ userId: 'p1', assignMetadata: countOnlyMetadata }]);
        walletReader.getWithdrawalCountsInWindow = vi.fn().mockResolvedValue(new Map([['p1', 1]]));
        await service.runDailyEvaluation();
        expect(walletReader.getWithdrawalCountsInWindow).toHaveBeenCalledWith(['p1'], 7);
        expect(tag.removePlayerTag).toHaveBeenCalledWith(
          expect.objectContaining({ playerId: 'p1', tagKey: 'high_risk' }),
        );
      });

      it('keeps the tag when the count is still at or above threshold', async () => {
        const { service, tag, walletReader } = makeServices({
          high_risk: makeRule({
            tagKey: 'high_risk',
            threshold: '1000',
            thresholdDays: 7,
            thresholdCount: 3,
          }),
        });
        tag.listActiveHoldersByTagKey = vi
          .fn()
          .mockResolvedValue([{ userId: 'p1', assignMetadata: countOnlyMetadata }]);
        walletReader.getWithdrawalCountsInWindow = vi.fn().mockResolvedValue(new Map([['p1', 3]]));
        await service.runDailyEvaluation();
        expect(tag.removePlayerTag).not.toHaveBeenCalledWith(
          expect.objectContaining({ tagKey: 'high_risk' }),
        );
      });

      it('treats a holder absent from the batched result as zero and removes the tag', async () => {
        const { service, tag, walletReader } = makeServices({
          high_risk: makeRule({
            tagKey: 'high_risk',
            threshold: '1000',
            thresholdDays: 7,
            thresholdCount: 3,
          }),
        });
        tag.listActiveHoldersByTagKey = vi
          .fn()
          .mockResolvedValue([{ userId: 'p1', assignMetadata: countOnlyMetadata }]);
        walletReader.getWithdrawalCountsInWindow = vi.fn().mockResolvedValue(new Map());
        await service.runDailyEvaluation();
        expect(tag.removePlayerTag).toHaveBeenCalledWith(
          expect.objectContaining({ playerId: 'p1', tagKey: 'high_risk' }),
        );
      });

      it('skips entirely when thresholdDays is null (amount-only rule, not resweepable)', async () => {
        const { service, tag } = makeServices({
          high_risk: makeRule({
            tagKey: 'high_risk',
            threshold: '1000',
            thresholdDays: null,
            thresholdCount: 3,
          }),
        });
        await service.runDailyEvaluation();
        expect(tag.listActiveHoldersByTagKey).not.toHaveBeenCalled();
      });

      it('skips entirely when thresholdCount is null (no frequency dimension to resweep)', async () => {
        const { service, tag } = makeServices({
          high_risk: makeRule({
            tagKey: 'high_risk',
            threshold: '1000',
            thresholdDays: 7,
            thresholdCount: null,
          }),
        });
        await service.runDailyEvaluation();
        expect(tag.listActiveHoldersByTagKey).not.toHaveBeenCalled();
      });

      it('skips when the rule is disabled', async () => {
        const { service, tag } = makeServices({
          high_risk: makeRule({
            tagKey: 'high_risk',
            threshold: '1000',
            thresholdDays: 7,
            thresholdCount: 3,
            isEnabled: false,
          }),
        });
        await service.runDailyEvaluation();
        expect(tag.listActiveHoldersByTagKey).not.toHaveBeenCalled();
      });

      it('does nothing when there are no holders', async () => {
        const { service, tag, walletReader } = makeServices({
          high_risk: makeRule({
            tagKey: 'high_risk',
            threshold: '1000',
            thresholdDays: 7,
            thresholdCount: 3,
          }),
        });
        tag.listActiveHoldersByTagKey = vi.fn().mockResolvedValue([]);
        await service.runDailyEvaluation();
        expect(walletReader.getWithdrawalCountsInWindow).not.toHaveBeenCalled();
        expect(tag.removePlayerTag).not.toHaveBeenCalled();
      });

      it('falls back to per-holder getWithdrawalCountInWindow when the batched method is absent from the adapter', async () => {
        const { service, tag, walletReader } = makeServices({
          high_risk: makeRule({
            tagKey: 'high_risk',
            threshold: '1000',
            thresholdDays: 7,
            thresholdCount: 3,
          }),
        });
        tag.listActiveHoldersByTagKey = vi.fn().mockResolvedValue([
          { userId: 'p1', assignMetadata: countOnlyMetadata },
          { userId: 'p2', assignMetadata: countOnlyMetadata },
        ]);
        // Simulate an external WalletReader implementation that predates the batched method.
        walletReader.getWithdrawalCountsInWindow = undefined;
        walletReader.getWithdrawalCountInWindow = vi.fn(async (userId: string) =>
          userId === 'p1' ? 1 : 5,
        );
        await service.runDailyEvaluation();
        expect(walletReader.getWithdrawalCountInWindow).toHaveBeenCalledWith('p1', 7);
        expect(walletReader.getWithdrawalCountInWindow).toHaveBeenCalledWith('p2', 7);
        expect(tag.removePlayerTag).toHaveBeenCalledWith(
          expect.objectContaining({ playerId: 'p1', tagKey: 'high_risk' }),
        );
        expect(tag.removePlayerTag).not.toHaveBeenCalledWith(
          expect.objectContaining({ playerId: 'p2', tagKey: 'high_risk' }),
        );
      });

      it('does not remove a holder whose assignMetadata shows an amount breach, even when the windowed count is below threshold (bug-fix case)', async () => {
        const { service, tag, walletReader } = makeServices({
          high_risk: makeRule({
            tagKey: 'high_risk',
            threshold: '1000',
            thresholdDays: 7,
            thresholdCount: 3,
          }),
        });
        tag.listActiveHoldersByTagKey = vi
          .fn()
          .mockResolvedValue([{ userId: 'p1', assignMetadata: amountBreachMetadata }]);
        walletReader.getWithdrawalCountsInWindow = vi.fn().mockResolvedValue(new Map([['p1', 0]]));
        await service.runDailyEvaluation();
        expect(tag.removePlayerTag).not.toHaveBeenCalled();
      });

      it('still removes a count-only-breach holder whose windowed count drops below threshold (existing behavior preserved)', async () => {
        const { service, tag, walletReader } = makeServices({
          high_risk: makeRule({
            tagKey: 'high_risk',
            threshold: '1000',
            thresholdDays: 7,
            thresholdCount: 3,
          }),
        });
        tag.listActiveHoldersByTagKey = vi
          .fn()
          .mockResolvedValue([{ userId: 'p1', assignMetadata: countOnlyMetadata }]);
        walletReader.getWithdrawalCountsInWindow = vi.fn().mockResolvedValue(new Map([['p1', 1]]));
        await service.runDailyEvaluation();
        expect(tag.removePlayerTag).toHaveBeenCalledWith(
          expect.objectContaining({ playerId: 'p1', tagKey: 'high_risk' }),
        );
      });

      it('does not remove a holder with null assignMetadata (legacy row), even when below threshold', async () => {
        const { service, tag, walletReader } = makeServices({
          high_risk: makeRule({
            tagKey: 'high_risk',
            threshold: '1000',
            thresholdDays: 7,
            thresholdCount: 3,
          }),
        });
        tag.listActiveHoldersByTagKey = vi
          .fn()
          .mockResolvedValue([{ userId: 'p1', assignMetadata: null }]);
        walletReader.getWithdrawalCountsInWindow = vi.fn().mockResolvedValue(new Map([['p1', 0]]));
        await service.runDailyEvaluation();
        expect(tag.removePlayerTag).not.toHaveBeenCalled();
      });
    });
  });

  describe('idempotency', () => {
    it('tryAssignTag swallows TagAlreadyInUseError', async () => {
      const { service, tag } = makeServices({
        large_depositor: makeRule({ tagKey: 'large_depositor', threshold: '500' }),
      });
      tag.assignPlayerTag = vi.fn().mockRejectedValue(new TagAlreadyInUseError());
      await expect(service.onDepositCompleted(depositPayload(500))).resolves.toBeUndefined();
    });

    it('tryRemoveTag swallows TagAssignmentNotFoundError', async () => {
      const { service, tag } = makeServices();
      tag.removePlayerTag = vi.fn().mockRejectedValue(new TagAssignmentNotFoundError(UID));
      await expect(service.onUserLogin({ userId: UID })).resolves.toBeUndefined();
    });
  });
});
