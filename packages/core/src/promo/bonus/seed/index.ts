import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '@openora/core/server';
import { promoWeight, promoWeightProfile } from '../schema/index.js';
import { DEFAULT_WEIGHT_PROFILE_NAME } from '../service/grant.service.js';

export async function seedDefaultWeightProfile(db: DrizzleDb): Promise<void> {
  const [inserted] = await db
    .insert(promoWeightProfile)
    .values({ name: DEFAULT_WEIGHT_PROFILE_NAME })
    .onConflictDoNothing({ target: promoWeightProfile.name })
    .returning({ id: promoWeightProfile.id });

  const profileId =
    inserted?.id ??
    (
      await db
        .select({ id: promoWeightProfile.id })
        .from(promoWeightProfile)
        .where(eq(promoWeightProfile.name, DEFAULT_WEIGHT_PROFILE_NAME))
    )[0]?.id;
  if (profileId === undefined) {
    throw new Error(
      'seedDefaultWeightProfile: profile insert lost the race and the lookup found nothing',
    );
  }

  await db
    .insert(promoWeight)
    .values([
      { profileId, scope: 'default', scopeRef: null, contributionPercent: '100' },
      { profileId, scope: 'product', scopeRef: 'sportsbook', contributionPercent: '0' },
      { profileId, scope: 'product', scopeRef: 'pvp', contributionPercent: '0' },
    ])
    .onConflictDoNothing();
}
