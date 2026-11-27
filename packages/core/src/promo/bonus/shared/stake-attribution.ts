import { MONEY_SCALE } from '@openora/core/contracts';
import {
  moneyAdd,
  moneyCompare,
  moneyMin,
  moneyDivide,
  moneyScaleBy,
  moneySubtract,
} from '@openora/core/server';
import { weightedStake } from './wagering-weight.js';

const ZERO = '0';
const MINOR_UNIT = `0.${'1'.padStart(MONEY_SCALE, '0')}`;

export type AttributionGrant<Id> = {
  id: Id;
  /** What the requirement still has room for. */
  headroom: string;
  /** This bet's contribution percent under the grant's own weights. */
  percent: string;
  /** The part of the stake this grant's own bonus funds paid. */
  bonusStake: string;
};

export type GrantAttribution<Id> = {
  id: Id;
  bonusStake: string;
  /** Real-funded stake this grant absorbed. */
  realStake: string;
  /** Weighted stake applied to the requirement, never more than its headroom. */
  progress: string;
};

/**
 * Splits one bet across the active grants it can score, given in rollover order (earliest expiry
 * first). A grant's own bonus-funded stake progresses that grant alone. The real-funded stake then
 * fills each requirement in turn: what a grant has no room for carries to the next, weighted
 * afresh by that grant's own percent, so no part of the stake is counted twice. Real stake no
 * requirement absorbs stays on the first grant with no progress, so a later win or void still
 * finds the whole real stake on the round.
 */
export function attributeStake<Id>(
  grants: readonly AttributionGrant<Id>[],
  realStake: string,
): GrantAttribution<Id>[] {
  const slots = grants.map((g) => {
    const own = weightedStake(g.bonusStake, g.percent);
    return {
      grant: g,
      realStake: ZERO,
      progress: moneyMin(own, g.headroom),
    };
  });

  let remaining = realStake;
  for (const slot of slots) {
    const { headroom, percent } = slot.grant;
    const room = moneySubtract(headroom, slot.progress);
    if (moneyCompare(percent, ZERO) <= 0 || moneyCompare(room, ZERO) <= 0) {
      continue;
    }
    const weighted = weightedStake(remaining, percent);
    if (moneyCompare(weighted, room) <= 0) {
      slot.progress = moneyAdd(slot.progress, weighted);
      slot.realStake = moneyAdd(slot.realStake, remaining);
      remaining = ZERO;
      break;
    }
    const consumed = stakeToFill(room, percent);
    slot.progress = headroom;
    slot.realStake = moneyAdd(slot.realStake, consumed);
    remaining = moneySubtract(remaining, consumed);
  }

  const [first] = slots;
  if (first) {
    first.realStake = moneyAdd(first.realStake, remaining);
  }

  return slots.map(({ grant, realStake: real, progress }) => ({
    id: grant.id,
    bonusStake: grant.bonusStake,
    realStake: real,
    progress,
  }));
}

/** The least stake whose weighted value at `percent` reaches `room`. */
function stakeToFill(room: string, percent: string): string {
  let stake = moneyDivide(moneyScaleBy(room, '100'), percent);
  while (moneyCompare(weightedStake(stake, percent), room) < 0) {
    stake = moneyAdd(stake, MINOR_UNIT);
  }
  return stake;
}
