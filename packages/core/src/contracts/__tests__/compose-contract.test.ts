import { describe, it, expect } from 'vitest';
import { oc } from '@orpc/contract';
import * as z from 'zod';
import { composeContract } from '../orpc/index.js';

const walletContract = {
  balance: oc
    .route({ method: 'GET', path: '/wallet/balance' })
    .output(z.object({ id: z.string() })),
};

describe('composeContract', () => {
  it('always includes health, even with no slices', () => {
    expect(composeContract({})).toHaveProperty('health');
  });

  it('mounts a slice under its own namespace alongside health', () => {
    const contract = composeContract({ wallet: walletContract });

    expect(contract).toHaveProperty('wallet.balance');
    expect(Object.keys(contract).sort()).toEqual(['health', 'wallet']);
  });

  it('lets a consumer shadow health with its own slice', () => {
    expect(composeContract({ health: walletContract })).toHaveProperty('health.balance');
  });

  it('leaves the source slice untouched', () => {
    composeContract({ wallet: walletContract });

    expect(Object.keys(walletContract)).toEqual(['balance']);
  });
});
