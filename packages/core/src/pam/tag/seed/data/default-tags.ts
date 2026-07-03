import { type CreateTagInput } from '@blurifycom/core/contracts';

export const DEFAULT_TAGS: CreateTagInput[] = [
  { key: 'high_roller', isSticky: false },
  { key: 'vip', isSticky: true },
  { key: 'bonus_abuser', isSticky: true },
  { key: 'high_risk', isSticky: false },
  { key: 'inactive', isSticky: false },
  { key: 'large_depositor', isSticky: false },
  { key: 'self_excluded', isSticky: true },
  { key: 'kyc_pending', isSticky: false },
  { key: 'kyc_rejected', isSticky: true },
  { key: 'test_account', isSticky: true },
];
