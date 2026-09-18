import type { DrizzleDb } from '@openora/core/server';
import { promoWeight, promoWeightProfile } from '../schema/index.js';
import { DEFAULT_WEIGHT_PROFILE_NAME } from '../service/grant.service.js';

/**
 * The profile a grant scores against when nothing named one - a chat gift, a rain drop, an
 * admin's hand-issued bonus. It counts every bet in full; an operator narrows it from the
 * backoffice. Without it those grants would be refused, which is why it is reference data
 * rather than something an operator has to remember to create.
 */
export async function seedDefaultWeightProfile(db: DrizzleDb): Promise<void> {
  const [profile] = await db
    .insert(promoWeightProfile)
    .values({ name: DEFAULT_WEIGHT_PROFILE_NAME })
    .onConflictDoNothing({ target: promoWeightProfile.name })
    .returning({ id: promoWeightProfile.id });
  if (!profile) {
    return;
  }
  await db
    .insert(promoWeight)
    .values({
      profileId: profile.id,
      scope: 'default',
      scopeRef: null,
      contributionPercent: '100',
    })
    .onConflictDoNothing();
}
