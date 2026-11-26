import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readJson } from '../index.js';
import { useBonusLockHarness } from './support/bonus-lock-harness.js';

const CONVERT = '/backoffice/promo/grants/convert-transfer-grants';

const { admin, player, grant, grantRow, bet, lose } = useBonusLockHarness('block', {
  config: {
    id: 'testing-promo-grant-conversion-config',
    file: './test-promo-grant-conversion-config-plugin.ts',
  },
});

const convert = async (body: Record<string, unknown>) => {
  const res = await admin().post(CONVERT, body);
  expect(res.status).toBe(200);
  return readJson(res);
};

const ids = (result: { converted: { grantId: string }[] }) =>
  result.converted.map((row) => row.grantId);

async function convertibleGrants(source: 'rain' | 'donation', count: number) {
  const made: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const { userId } = await player('1');
    made.push(await grant(userId, { source, amount: '10', linked: '0' }));
  }
  return made.sort();
}

describe('walking the conversion with a cursor', () => {
  it('visits every convertible grant exactly once, in dry run and for real', async () => {
    const made = await convertibleGrants('rain', 5);
    const holder = await player('1');
    const openGrant = await grant(holder.userId, { source: 'rain', amount: '10', linked: '0' });
    const round = randomUUID();
    expect(await bet(holder.userId, '2', round)).toMatchObject({ ok: true });
    const convertible = made;

    const previewed: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < 6; page += 1) {
      const result = await convert({ sources: ['rain'], limit: 2, dryRun: true, after });
      expect(result.skippedOpenRound).toBe(1);
      previewed.push(...ids(result));
      if (result.nextCursor === null) {
        break;
      }
      after = result.nextCursor;
    }
    expect(previewed).toEqual(convertible);
    expect(previewed).not.toContain(openGrant);
    expect((await grantRow(convertible[0] as string)).status).toBe('active');

    const walked: string[] = [];
    after = undefined;
    for (let page = 0; page < 6; page += 1) {
      const result = await convert({ sources: ['rain'], limit: 2, after });
      walked.push(...ids(result));
      if (result.nextCursor === null) {
        break;
      }
      after = result.nextCursor;
    }
    expect(walked).toEqual(convertible);
    for (const id of convertible) {
      expect((await grantRow(id)).status).toBe('completed');
    }

    expect(await convert({ sources: ['rain'] })).toMatchObject({
      converted: [],
      skippedOpenRound: 1,
      remaining: 1,
      nextCursor: null,
    });

    await lose(holder.userId, round);
    const last = await convert({ sources: ['rain'] });
    expect(ids(last)).toEqual([openGrant]);
    expect(last.skippedOpenRound).toBe(0);
    expect(await convert({ sources: ['rain'] })).toMatchObject({ converted: [], remaining: 0 });
  });

  it('starts after any id, past the last grant and refuses a malformed one', async () => {
    const made = await convertibleGrants('donation', 4);
    const pivot = randomUUID();
    const expected = made.filter((id) => id > pivot);

    const preview = await convert({ sources: ['donation'], dryRun: true, after: pivot });
    expect(ids(preview)).toEqual(expected);

    const none = await convert({
      sources: ['donation'],
      after: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
    });
    expect(none).toMatchObject({ converted: [], nextCursor: null, remaining: made.length });

    for (const bad of ['not-a-uuid', '', 42]) {
      expect((await admin().post(CONVERT, { sources: ['donation'], after: bad })).status).toBe(400);
    }

    const real = await convert({ sources: ['donation'], after: pivot });
    expect(ids(real)).toEqual(expected);
    expect(real.remaining).toBe(made.length - expected.length);
    for (const id of made) {
      expect((await grantRow(id)).status).toBe(expected.includes(id) ? 'completed' : 'active');
    }
  });
});
