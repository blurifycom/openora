import { type CreateTagInput } from '../../../../contracts/schemas/tag.js';

export const DEFAULT_TAGS: CreateTagInput[] = [
  { key: 'high_roller', color: '#8B5CF6', isSticky: false },
  { key: 'vip', color: '#2563EB', isSticky: true },
  { key: 'bonus_abuser', color: '#DC2626', isSticky: true },
  { key: 'high_risk', color: '#B91C1C', isSticky: false },
  { key: 'inactive', color: '#6B7280', isSticky: false },
  { key: 'large_depositor', color: '#059669', isSticky: false },
  { key: 'self_excluded', color: '#7C3AED', isSticky: true },
  { key: 'kyc_pending', color: '#D97706', isSticky: false },
  { key: 'kyc_rejected', color: '#EF4444', isSticky: true },
  { key: 'test_account', color: '#4B5563', isSticky: true },
];
