import { describe, it, expect } from 'vitest';
import {
  BulkGameGeoRuleInputSchema,
  RequestKycResubmissionInputSchema,
} from '../contract/index.js';
import { RequestEnhancedKycPayloadSchema } from '../contract/agent-tools.js';
import { ReplaceGameGeoRulesInputSchema } from '@openora/core/contracts';

const USER = '11111111-1111-4111-8111-111111111111';

describe('RequestKycResubmissionInputSchema', () => {
  const parse = (reason: string) =>
    RequestKycResubmissionInputSchema.safeParse({ userId: USER, tier: 'advanced', reason });

  it('accepts a 500-character reason', () => {
    expect(parse('a'.repeat(500)).success).toBe(true);
  });

  it('trims surrounding spaces before applying the 500-character cap', () => {
    const result = parse(`  ${'a'.repeat(500)}  `);

    expect(result.success).toBe(true);
    expect(result.data?.reason).toBe('a'.repeat(500));
  });

  it('rejects a 501-character reason', () => {
    expect(parse('a'.repeat(501)).success).toBe(false);
  });

  it('rejects an all-space reason', () => {
    expect(parse('     ').success).toBe(false);
  });
});

describe('BoundedReasonSchema call sites', () => {
  const GAME = '22222222-2222-4222-8222-222222222222';
  const sites: Array<
    [string, (reason: string) => { success: boolean; data?: { reason: string } }]
  > = [
    [
      'request_enhanced_kyc payload',
      (reason) => RequestEnhancedKycPayloadSchema.safeParse({ playerId: USER, reason }),
    ],
    [
      'bulk game geo rule',
      (reason) =>
        BulkGameGeoRuleInputSchema.safeParse({ gameIds: [GAME], countryCode: 'DE', reason }),
    ],
    [
      'replace game geo rules',
      (reason) => ReplaceGameGeoRulesInputSchema.safeParse({ source: 'vendor', rules: [], reason }),
    ],
  ];

  it.each(sites)('%s trims, accepts 500 and rejects 501 and blank', (_name, parse) => {
    const ok = parse(`  ${'a'.repeat(500)}  `);
    expect(ok.success).toBe(true);
    expect(ok.data?.reason).toBe('a'.repeat(500));
    expect(parse('a'.repeat(501)).success).toBe(false);
    expect(parse('   ').success).toBe(false);
  });
});
