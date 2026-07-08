import { type UpsertTagRuleInput } from '@openora/core/contracts';

export const DEFAULT_TAG_RULES: UpsertTagRuleInput[] = [
  {
    tagKey: 'high_roller',
    isEnabled: false,
    thresholdAmount: null,
    thresholdDays: null,
    thresholdCount: null,
  },
  {
    tagKey: 'large_depositor',
    isEnabled: false,
    thresholdAmount: null,
    thresholdDays: null,
    thresholdCount: null,
  },
  {
    tagKey: 'high_risk',
    isEnabled: false,
    thresholdAmount: null,
    thresholdDays: null,
    thresholdCount: null,
  },
  {
    tagKey: 'inactive',
    isEnabled: false,
    thresholdAmount: null,
    thresholdDays: null,
    thresholdCount: null,
  },
  {
    tagKey: 'kyc_pending',
    isEnabled: true,
    thresholdAmount: null,
    thresholdDays: null,
    thresholdCount: null,
  },
  {
    tagKey: 'kyc_rejected',
    isEnabled: true,
    thresholdAmount: null,
    thresholdDays: null,
    thresholdCount: null,
  },
];
