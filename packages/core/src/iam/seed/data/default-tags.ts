export type DefaultTag = {
  key: string;
  name: string;
  color: string;
  description: string;
  is_sticky: boolean;
};

export const DEFAULT_TAGS: readonly DefaultTag[] = [
  {
    key: 'high_roller',
    name: 'High Roller',
    color: '#8B5CF6',
    description: 'Lifetime deposits exceed the configured threshold.',
    is_sticky: false,
  },
  {
    key: 'vip',
    name: 'VIP',
    color: '#2563EB',
    description: 'Manually promoted by a VIP Manager.',
    is_sticky: true,
  },
  {
    key: 'bonus_abuser',
    name: 'Bonus Abuser',
    color: '#DC2626',
    description: 'Flagged by risk rules (e.g. multi-account or bonus abuse patterns).',
    is_sticky: true,
  },
  {
    key: 'high_risk',
    name: 'High Risk',
    color: '#B91C1C',
    description: 'Withdrawal amount or frequency exceeds the configured threshold.',
    is_sticky: false,
  },
  {
    key: 'inactive',
    name: 'Inactive',
    color: '#6B7280',
    description: 'No login for the configured number of days.',
    is_sticky: false,
  },
  {
    key: 'large_depositor',
    name: 'Large Depositor',
    color: '#059669',
    description: 'A single deposit exceeds the configured threshold.',
    is_sticky: false,
  },
  {
    key: 'self_excluded',
    name: 'Self Excluded',
    color: '#7C3AED',
    description: 'Player has activated self-exclusion.',
    is_sticky: true,
  },
  {
    key: 'kyc_pending',
    name: 'KYC Pending',
    color: '#D97706',
    description: 'KYC verification has been initiated but is not yet complete.',
    is_sticky: false,
  },
  {
    key: 'kyc_rejected',
    name: 'KYC Rejected',
    color: '#EF4444',
    description: 'KYC verification was rejected by the provider.',
    is_sticky: true,
  },
  {
    key: 'test_account',
    name: 'Test Account',
    color: '#4B5563',
    description: 'Manually flagged by a Super Admin.',
    is_sticky: true,
  },
];
