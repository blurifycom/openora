import { describe, expect, it } from 'vitest';
import { findingValues } from '../reconciliation-finding.service.js';

const OPTIONAL_COLUMNS = [
  'currency',
  'network',
  'amount',
  'address',
  'tag',
  'txHash',
  'sourceAddress',
  'externalId',
  'transactionId',
  'detail',
] as const;

const REQUIRED = { runId: 'run-1', providerName: 'acme-custody', kind: 'stuck_sweep' } as const;

describe('findingValues', () => {
  it('stores every omitted optional column as null, never undefined', () => {
    const values = findingValues(REQUIRED);
    for (const column of OPTIONAL_COLUMNS) {
      expect(values[column]).toBeNull();
    }
  });

  it('copies every provided column verbatim, keeping the amount string unrounded', () => {
    const input = {
      ...REQUIRED,
      currency: 'USDT',
      network: 'TRON',
      amount: '0.123456789012',
      address: 'TAddress',
      tag: '0',
      txHash: '0xhash',
      sourceAddress: 'TSource',
      externalId: 'ext-1',
      transactionId: '55555555-5555-4555-8555-555555555555',
      detail: 'why',
    };
    expect(findingValues(input)).toEqual(input);
  });

  it.each(['', '0'])('keeps a falsy but present tag %j instead of nulling it', (tag) => {
    expect(findingValues({ ...REQUIRED, tag }).tag).toBe(tag);
  });

  it('keeps the dedup key externalId so a re-run of the same event conflicts', () => {
    expect(findingValues({ ...REQUIRED, externalId: 'ext-1' }).externalId).toBe('ext-1');
  });

  it('writes exactly the finding columns and nothing a caller smuggles in', () => {
    const smuggled = { ...REQUIRED, status: 'resolved', resolvedBy: 'someone' };
    expect(Object.keys(findingValues(smuggled)).sort()).toEqual(
      ['runId', 'providerName', 'kind', ...OPTIONAL_COLUMNS].sort(),
    );
  });
});
