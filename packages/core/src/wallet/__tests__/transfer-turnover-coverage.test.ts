import { describe, expect, it } from 'vitest';
import { definePlatformConfig } from '@openora/core/contracts';
import { cashTransferKindsWithoutTurnover } from '../service/wallet-commands.service.js';

const walletConfig = (wallet: Parameters<typeof definePlatformConfig>[0]['wallet']) =>
  definePlatformConfig({ wallet }).wallet;

describe('cashTransferKindsWithoutTurnover', () => {
  it('names nothing while transfers stay bonus grants', () => {
    expect(cashTransferKindsWithoutTurnover(undefined)).toEqual([]);
    expect(
      cashTransferKindsWithoutTurnover(
        walletConfig({ transferCredits: 'bonus_grant', turnover: { multiplier: '0' } }),
      ),
    ).toEqual([]);
  });

  it('names every transfer kind when cash transfers meet a multiplier of 0', () => {
    expect(
      cashTransferKindsWithoutTurnover(
        walletConfig({
          transferCredits: 'cash',
          turnover: { multiplier: '0', creditTypes: ['deposit', 'gift', 'rain', 'donation'] },
        }),
      ),
    ).toEqual(['gift', 'rain', 'donation']);
  });

  it('names the transfer kinds missing from creditTypes', () => {
    expect(
      cashTransferKindsWithoutTurnover(
        walletConfig({
          transferCredits: 'cash',
          turnover: { multiplier: '1', creditTypes: ['deposit', 'rain'] },
        }),
      ),
    ).toEqual(['gift', 'donation']);
  });

  it('names nothing when every transfer kind carries turnover', () => {
    expect(
      cashTransferKindsWithoutTurnover(
        walletConfig({
          transferCredits: 'cash',
          turnover: { multiplier: '1', creditTypes: ['deposit', 'gift', 'rain', 'donation'] },
        }),
      ),
    ).toEqual([]);
  });
});
