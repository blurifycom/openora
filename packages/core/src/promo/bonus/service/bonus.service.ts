import { eq } from 'drizzle-orm';
import type { Uuid, WagerContext } from '@openora/core/contracts';
import { type DrizzleTx } from '@openora/core/server';
import { promoWeight } from '../schema/index.js';
import { resolveContributionPercent, weightedStake } from '../shared/wagering-weight.js';

// Pure business logic for Bonus. A plain class wired by plugin.ts via the composition
// container (no decorators). Money mutations MUST run inside a transaction
// (lint: money-in-transaction).
export class BonusService {
  /**
   * The part of `stake` that counts toward a wagering requirement under `profileId`.
   *
   * Takes the caller's transaction handle: this runs inside the wallet debit that placed the
   * bet, so the weight a bet was scored at and the bet itself cannot end up on different sides
   * of a rollback.
   */
  async weightedContribution(
    tx: DrizzleTx,
    { profileId, stake, context }: { profileId: Uuid; stake: string; context: WagerContext },
  ): Promise<{ contributionPercent: string; weightedAmount: string }> {
    const rows = await tx
      .select({
        scope: promoWeight.scope,
        scopeRef: promoWeight.scopeRef,
        contributionPercent: promoWeight.contributionPercent,
      })
      .from(promoWeight)
      .where(eq(promoWeight.profileId, profileId));

    const contributionPercent = resolveContributionPercent(rows, context);
    return { contributionPercent, weightedAmount: weightedStake(stake, contributionPercent) };
  }
}
