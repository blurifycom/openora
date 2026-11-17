import type { Player, RgStanding } from '@openora/core/contracts';
import type { RgPlayerState } from '../contract/index.js';

/** The RG standing reader's facts as the `rg.player_state` tool serves them: dates as ISO times. */
export function toRgPlayerState(playerId: Player['id'], standing: RgStanding): RgPlayerState {
  return {
    playerId,
    restricted: standing.restricted,
    activeExclusions: standing.activeExclusions.map((exclusion) => ({
      kind: exclusion.kind,
      startsAt: exclusion.startsAt.toISOString(),
      expiresAt: exclusion.expiresAt?.toISOString() ?? null,
      isPermanent: exclusion.isPermanent,
    })),
    selfExclusionsOnRecord: standing.selfExclusionsOnRecord,
    lastSelfExclusionEndedAt: standing.lastSelfExclusionEndedAt?.toISOString() ?? null,
    lastCoolingOffEndedAt: standing.lastCoolingOffEndedAt?.toISOString() ?? null,
    activeFlags: standing.activeFlags.map((flag) => ({
      flagType: flag.flagType,
      limitType: flag.limitType,
      flaggedAt: flag.flaggedAt.toISOString(),
    })),
    limits: standing.limits.map((limit) => ({
      type: limit.type,
      period: limit.period,
      amount: limit.type === 'session' ? null : limit.amount,
      currency: limit.type === 'session' ? null : limit.currency,
      minutes: limit.type === 'session' ? limit.minutes : null,
      pendingKind: limit.pendingKind,
      pendingRequestedAt: limit.pendingRequestedAt?.toISOString() ?? null,
    })),
    pivotCurrency: standing.pivotCurrency,
    windows: standing.windows,
  };
}
