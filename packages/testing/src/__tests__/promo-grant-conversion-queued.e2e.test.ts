import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readJson } from '../index.js';
import { expectMoney, useBonusLockHarness } from './support/bonus-lock-harness.js';

const CONVERT = '/backoffice/promo/grants/convert-transfer-grants';

const { admin, player, grant, grantRow, realBalance } = useBonusLockHarness('block', {
  config: {
    id: 'testing-promo-grant-conversion-per-source-config',
    file: './test-promo-grant-conversion-per-source-config-plugin.ts',
  },
});

const convert = async (body: Record<string, unknown>) => {
  const res = await admin().post(CONVERT, body);
  expect(res.status).toBe(200);
  return readJson(res);
};

describe('a queued transfer grant under per-source concurrency', () => {
  it('converts with the active one and can no longer be activated', async () => {
    const { client, userId } = await player('1');
    const active = await grant(userId, { source: 'gift', amount: '10', linked: '0' });
    const queued = await grant(userId, { source: 'gift', amount: '7', linked: '0' });
    expect((await grantRow(active)).status).toBe('active');
    expect((await grantRow(queued)).status).toBe('pending');

    const preview = await convert({ sources: ['gift'], dryRun: true });
    expect(preview.remaining).toBe(2);

    const result = await convert({ sources: ['gift'] });
    expect(result.converted.map((row: { grantId: string }) => row.grantId).sort()).toEqual(
      [active, queued].sort(),
    );
    expect(result).toMatchObject({ remaining: 0 });
    expect(result.failed).toBeUndefined();
    expect((await grantRow(queued)).status).toBe('completed');
    expectMoney(await realBalance(userId), '18', 'deposit plus both grants as cash');

    const activation = await client.post(`/promo/grants/${queued}/activate`, {});
    expect(activation.status).toBe(409);
    expect((await grantRow(queued)).status).toBe('completed');
  });
});

describe('a grant whose cash the wallet refuses', () => {
  it('stays live, is named in failed and does not stop the rest of the batch', async () => {
    const { userId } = await player('1');
    const good = await grant(userId, { source: 'donation', amount: '10', linked: '0' });
    const orphan = await grant(randomUUID(), { source: 'donation', amount: '10', linked: '0' });

    const result = await convert({ sources: ['donation'] });

    expect(result.converted.map((row: { grantId: string }) => row.grantId)).toEqual([good]);
    expect(result.failed).toEqual([{ grantId: orphan, reason: 'credit_refused' }]);
    expect(result.remaining).toBe(1);
    expect((await grantRow(orphan)).status).toBe('active');
    expect((await grantRow(good)).status).toBe('completed');
  });
});
