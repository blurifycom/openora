import type { DrizzleDb } from '@openora/core/server';
import { promoWeight, promoWeightProfile } from '../schema/index.js';
import { DEFAULT_WEIGHT_PROFILE_NAME } from '../service/grant.service.js';

/**
 * The profile a grant scores against when nothing named one - a chat gift, a rain drop, an
 * admin's hand-issued bonus. It counts every bet in full; an operator narrows it from the
 * backoffice.
 *
 * Reference data, seeded the way IAM roles and player tags are: an environment that runs
 * migrations without running the seeds has no default profile, and every grant with no offer
 * behind it is refused until one exists. That is the fail-closed direction, but it is a real
 * deployment step rather than something the schema guarantees.
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
