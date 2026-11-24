import { expect, it } from 'vitest';
import { readJson } from '../index.js';
import { expectMoney, useBonusLockHarness } from './fixtures/bonus-lock-harness.js';

const { admin, player, grant, grantRow, realBalance } = useBonusLockHarness('block', {
  config: {
    id: 'testing-wallet-turnover-off-config',
    file: './test-wallet-turnover-off-config-plugin.ts',
  },
});

it('refuses to convert while the turnover multiplier is 0', async () => {
  const { userId } = await player('1');
  const grantId = await grant(userId, { source: 'gift', amount: '10', linked: '0' });

  const res = await admin().post('/backoffice/promo/grants/convert-transfer-grants', {
    sources: ['gift'],
  });

  expect(res.status).toBe(409);
  expect(await readJson(res)).toMatchObject({
    code: 'CONFLICT',
    data: { reason: 'turnover_disabled' },
  });
  expect((await grantRow(grantId)).status).toBe('active');
  expectMoney(await realBalance(userId), '1', 'real balance');
});
