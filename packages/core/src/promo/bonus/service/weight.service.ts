import { asc, eq } from 'drizzle-orm';
import { type AuditWritePort, type Uuid } from '@openora/core/contracts';
import { makeConflictError, makeNotFoundError, type DrizzleService } from '@openora/core/server';
import { promoWeight, promoWeightProfile } from '../schema/index.js';
import type {
  CreateWagerWeightProfileInput,
  SetWagerWeightsInput,
  WagerWeightProfileDetail,
} from '../contract/index.js';

export const WagerWeightProfileNameTakenError = makeConflictError(
  'WagerWeightProfileNameTakenError',
  'a wagering weight profile already goes by that name',
);

export const WeightProfileNotFoundError = makeNotFoundError('WagerWeightProfile');

/**
 * What an operator configures to decide how much of a bet clears a wagering requirement.
 *
 * Editing a profile never reaches a bonus a player already holds: a grant snapshots the rows it
 * scores against at grant time, so this surface only shapes the bonuses granted after it.
 */
export class WeightService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly audit: AuditWritePort,
  ) {}

  async list(): Promise<WagerWeightProfileDetail[]> {
    const rows = await this.drizzle.db
      .select({ profile: promoWeightProfile, weight: promoWeight })
      .from(promoWeightProfile)
      .leftJoin(promoWeight, eq(promoWeight.profileId, promoWeightProfile.id))
      .orderBy(asc(promoWeightProfile.name), asc(promoWeight.scope), asc(promoWeight.scopeRef));

    const byId = new Map<string, WagerWeightProfileDetail>();
    for (const { profile, weight } of rows) {
      const detail = byId.get(profile.id) ?? toDetail(profile, []);
      if (weight) {
        detail.weights.push(toWeight(weight));
      }
      byId.set(profile.id, detail);
    }
    return [...byId.values()];
  }

  async create(
    adminId: Uuid,
    input: CreateWagerWeightProfileInput,
  ): Promise<WagerWeightProfileDetail> {
    return this.drizzle.db.transaction(async (tx) => {
      // The unique index is the guard rather than a read: two admins saving the same name at once
      // would both find it free.
      const [created] = await tx
        .insert(promoWeightProfile)
        .values({ name: input.name })
        .onConflictDoNothing({ target: promoWeightProfile.name })
        .returning();
      if (!created) {
        throw new WagerWeightProfileNameTakenError();
      }
      await this.audit.recordInTransaction(tx, {
        actorId: adminId,
        actorType: 'admin',
        action: 'promo.weight_profile.created',
        resourceType: 'promo_weight_profile',
        resourceId: created.id,
        after: { name: created.name },
      });
      // A profile with no rows scores every bet at zero, so a grant made against it can never be
      // wagered down. Nothing is granted against a profile that was only just created, but the
      // caller is told the set is empty rather than left to assume a default.
      return toDetail(created, []);
    });
  }

  /** Replaces the profile's rows outright, so a saved profile is never half a profile. */
  async set(adminId: Uuid, input: SetWagerWeightsInput): Promise<WagerWeightProfileDetail> {
    return this.drizzle.db.transaction(async (tx) => {
      const [profile] = await tx
        .select()
        .from(promoWeightProfile)
        .where(eq(promoWeightProfile.id, input.id))
        .for('update');
      if (!profile) {
        throw new WeightProfileNotFoundError(input.id);
      }

      const before = await tx
        .select()
        .from(promoWeight)
        .where(eq(promoWeight.profileId, profile.id));

      await tx.delete(promoWeight).where(eq(promoWeight.profileId, profile.id));
      const inserted =
        input.weights.length === 0
          ? []
          : await tx
              .insert(promoWeight)
              .values(input.weights.map((w) => ({ ...w, profileId: profile.id })))
              .returning();

      await this.audit.recordInTransaction(tx, {
        actorId: adminId,
        actorType: 'admin',
        action: 'promo.weight_profile.set',
        resourceType: 'promo_weight_profile',
        resourceId: profile.id,
        before: { weights: before.map(toWeight) },
        after: { weights: inserted.map(toWeight) },
      });
      return toDetail(profile, inserted.map(toWeight));
    });
  }
}

type ProfileRow = typeof promoWeightProfile.$inferSelect;
type WeightRow = typeof promoWeight.$inferSelect;

const toWeight = (row: WeightRow) => ({
  id: row.id,
  scope: row.scope,
  scopeRef: row.scopeRef,
  contributionPercent: row.contributionPercent,
  createdAt: row.createdAt.toISOString(),
});

const toDetail = (
  row: ProfileRow,
  weights: WagerWeightProfileDetail['weights'],
): WagerWeightProfileDetail => ({
  id: row.id,
  name: row.name,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  weights,
});
