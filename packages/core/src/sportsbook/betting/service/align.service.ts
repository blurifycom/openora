import { eq } from 'drizzle-orm';
import {
  createLogger,
  makeConflictError,
  moneyEquals,
  type AdminCaller,
  type DrizzleService,
  type DrizzleTx,
} from '@openora/core/server';
import {
  SportsbookProviderBetStatusSchema,
  type AuditWritePort,
  type SportsbookProvider,
  type SportsbookProviderBetStatus,
  type SportsbookRefusalReason,
} from '@openora/core/contracts';
import type { AlignSportsbookBetOutput, SportsbookTransactionKind } from '../contract/index.js';
import { sportsbookBet, type SportsbookBetRow } from '../schema/index.js';
import { SportsbookBetNotFoundError, toAdminBet } from './bet-query.service.js';
import { fileFinding } from './finding.service.js';
import {
  ALIGN_TX_PREFIX,
  isValidSettlement,
  type LedgerStep,
  type SportsbookLedgerService,
} from './ledger.service.js';
import { SportsbookProviderUnavailableError } from './session.service.js';

const logger = createLogger('sportsbook');

export const SportsbookAlignProviderError = makeConflictError(
  'SportsbookAlignProviderError',
  'This bet belongs to a provider that is not bound',
  { reason: 'provider_not_bound' },
);

export const SportsbookBetChangedError = makeConflictError(
  'SportsbookBetChangedError',
  'The bet changed while the provider was asked; align it again',
  { reason: 'bet_changed' },
);

/** `applied` lists the steps that committed before the refused one. */
export class SportsbookAlignRefusedError extends Error {
  readonly data: { reason: 'ledger_refused'; refusal: SportsbookRefusalReason; applied: string };

  constructor(refusal: SportsbookRefusalReason, applied: readonly SportsbookTransactionKind[]) {
    super(`The ledger refused to align this bet: ${refusal}`);
    this.name = 'SportsbookAlignRefusedError';
    this.data = { reason: 'ledger_refused', refusal, applied: applied.join(',') };
  }
}

/** Deterministic, so a repeated align of the same observation replays instead of moving twice. */
function alignTxId(
  bet: Pick<SportsbookBetRow, 'id'>,
  version: number,
  kind: SportsbookTransactionKind,
): string {
  return `${ALIGN_TX_PREFIX}${bet.id}:v${version}:${kind}`;
}

type Alignment = { steps: LedgerStep[]; mismatch: boolean };

/** The guarded ledger steps that bring the bet to what the provider reports, or a mismatch core cannot apply. */
function alignmentSteps(bet: SportsbookBetRow, observed: SportsbookProviderBetStatus): Alignment {
  const key = { provider: bet.provider, providerBetId: bet.providerBetId };
  const confirm = (): LedgerStep => ({
    kind: 'confirm',
    args: { ...key, providerTxId: alignTxId(bet, bet.version, 'confirm') },
  });
  const settle = (version: number): LedgerStep[] =>
    observed.status === 'settled'
      ? [
          {
            kind: 'settle',
            args: {
              ...key,
              providerTxId: alignTxId(bet, version, 'settle'),
              result: observed.result,
              payout: observed.payout,
              expectedVersion: version,
            },
          },
        ]
      : [];
  const reopen = (): LedgerStep => ({
    kind: 'reopen',
    args: {
      ...key,
      providerTxId: alignTxId(bet, bet.version, 'reopen'),
      expectedVersion: bet.version,
    },
  });
  const none: Alignment = { steps: [], mismatch: false };
  const mismatch: Alignment = { steps: [], mismatch: true };
  if (observed.status === 'pending') {
    return none;
  }
  if (observed.status === 'settled' && !isValidSettlement(bet, observed.result, observed.payout)) {
    return mismatch;
  }

  switch (bet.status) {
    case 'reserved':
      if (observed.status === 'rejected' || observed.status === 'not_found') {
        return {
          steps: [
            {
              kind: 'cancel',
              args: {
                ...key,
                providerTxId: alignTxId(bet, bet.version, 'cancel'),
                reason: observed.status === 'rejected' ? 'rejected' : 'discarded',
              },
            },
          ],
          mismatch: false,
        };
      }
      return { steps: [confirm(), ...settle(bet.version)], mismatch: false };
    case 'accepted':
      if (observed.status === 'accepted') {
        return none;
      }
      return observed.status === 'settled'
        ? { steps: settle(bet.version), mismatch: false }
        : mismatch;
    case 'settled':
      if (observed.status === 'accepted') {
        return { steps: [reopen()], mismatch: false };
      }
      if (observed.status !== 'settled') {
        return mismatch;
      }
      if (observed.result === bet.result && moneyEquals(observed.payout, bet.payoutTotal)) {
        return none;
      }
      return { steps: [reopen(), ...settle(bet.version + 1)], mismatch: false };
    case 'cancelled':
      return observed.status === 'rejected' || observed.status === 'not_found' ? none : mismatch;
  }
}

function betSnapshot(bet: SportsbookBetRow) {
  return {
    status: bet.status,
    version: bet.version,
    result: bet.result,
    payoutTotal: bet.payoutTotal,
  };
}

export type SportsbookAlignDeps = {
  drizzle: DrizzleService;
  ledger: SportsbookLedgerService;
  audit: AuditWritePort;
  provider?: SportsbookProvider;
};

export class SportsbookAlignService {
  private readonly drizzle: DrizzleService;
  private readonly ledger: SportsbookLedgerService;
  private readonly audit: AuditWritePort;
  private readonly provider: SportsbookProvider | undefined;

  constructor(deps: SportsbookAlignDeps) {
    this.drizzle = deps.drizzle;
    this.ledger = deps.ledger;
    this.audit = deps.audit;
    this.provider = deps.provider;
  }

  /** Asks the provider, outside any transaction. */
  async observe(bet: SportsbookBetRow): Promise<SportsbookProviderBetStatus> {
    const provider = this.provider;
    if (!provider) {
      throw new SportsbookProviderUnavailableError();
    }
    if (provider.name !== bet.provider) {
      throw new SportsbookAlignProviderError();
    }
    try {
      return SportsbookProviderBetStatusSchema.parse(
        await provider.getBetStatus({ providerBetId: bet.providerBetId }),
      );
    } catch (err) {
      logger.warn({ err, betId: bet.id }, 'sportsbook: provider bet status lookup failed');
      throw new SportsbookProviderUnavailableError();
    }
  }

  async align(id: SportsbookBetRow['id'], actor: AdminCaller): Promise<AlignSportsbookBetOutput> {
    const observedAt = await this.current(id);
    const providerStatus = await this.observe(observedAt);
    const applied = await this.apply(observedAt, providerStatus, actor);
    return { bet: toAdminBet(await this.current(id)), providerStatus, applied };
  }

  /** Applies the answer about `observedAt` unless the bet moved since. A null actor is the reconciliation job. */
  async apply(
    observedAt: SportsbookBetRow,
    providerStatus: SportsbookProviderBetStatus,
    actor: AdminCaller | null,
  ): Promise<SportsbookTransactionKind[]> {
    const bet = await this.current(observedAt.id);
    if (bet.status !== observedAt.status || bet.version !== observedAt.version) {
      throw new SportsbookBetChangedError();
    }
    const { steps, mismatch } = alignmentSteps(bet, providerStatus);

    if (mismatch) {
      await this.drizzle.db.transaction(async (tx) => {
        await fileFinding(tx, {
          kind: 'provider_mismatch',
          dedupeKey: `provider_mismatch:${bet.id}:v${bet.version}:${providerStatus.status}`,
          provider: bet.provider,
          betId: bet.id,
          userId: bet.userId,
          detail: { betStatus: bet.status, providerStatus },
        });
        if (actor) {
          await this.recordAudit(tx, {
            actor,
            before: bet,
            after: bet,
            step: null,
            providerStatus,
          });
        }
      });
    }

    const applied: SportsbookTransactionKind[] = [];
    let before = bet;
    for (const step of steps) {
      const outcome = await this.ledger.applyStep(step, async (tx, after) => {
        await this.recordAudit(tx, { actor, before, after, step: step.kind, providerStatus });
        before = after;
      });
      if (outcome.status === 'refused') {
        throw new SportsbookAlignRefusedError(outcome.reason, applied);
      }
      if (outcome.status === 'applied') {
        applied.push(step.kind);
      }
    }
    return applied;
  }

  async current(id: SportsbookBetRow['id']): Promise<SportsbookBetRow> {
    const [bet] = await this.drizzle.db
      .select()
      .from(sportsbookBet)
      .where(eq(sportsbookBet.id, id));
    if (!bet) {
      throw new SportsbookBetNotFoundError(id);
    }
    return bet;
  }

  private async recordAudit(
    tx: DrizzleTx,
    {
      actor,
      before,
      after,
      step,
      providerStatus,
    }: {
      actor: AdminCaller | null;
      before: SportsbookBetRow;
      after: SportsbookBetRow;
      step: SportsbookTransactionKind | null;
      providerStatus: SportsbookProviderBetStatus;
    },
  ): Promise<void> {
    await this.audit.recordInTransaction(tx, {
      actorId: actor?.userId ?? null,
      actorType: actor ? 'admin' : 'system',
      action: 'sportsbook.bet.aligned',
      resourceType: 'sportsbook_bet',
      resourceId: after.id,
      before: betSnapshot(before),
      after: { ...betSnapshot(after), step, providerStatus },
      ip: actor?.ip,
      userAgent: actor?.userAgent,
    });
  }
}
