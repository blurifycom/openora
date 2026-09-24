import { eq } from 'drizzle-orm';
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
 *
 * Always resolves the profile id and always upserts its default weight - a profile that already
 * exists but is missing that weight (a partial prior seed, or one created by hand) is repaired,
 * not skipped. Skipping it leaves every bet scoring 0 percent and a bonus that can never complete.
 */
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
    .values({
      profileId,
      scope: 'default',
      scopeRef: null,
      contributionPercent: '100',
    })
    .onConflictDoNothing();
}
