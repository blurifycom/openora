import { DrizzleService } from '@openora/core/server';
import type { EventBus, DrizzleDb } from '@openora/core/server';
import type { KycStatus, KycStatusWriter, KycStatusSource, Player } from '@openora/core/contracts';
import { eq, sql } from 'drizzle-orm';
import { player } from '@openora/core/pam/schema/profile';
import { PlayerNotFoundError } from './player.service.js';

type ConditionalUpdateRow = { previous_status: KycStatus };

/**
 * The single writer of `player.kycStatus` (the KYC_STATUS_WRITER seam). Every status
 * change - admin override, vendor decision, webhook, threshold re-KYC - flows through
 * here, so there is exactly one write path + one `compliance.kyc.updated` emit. The
 * guard-then-write is a single conditional UPDATE, never a select-then-update, so
 * concurrent callers cannot double-emit.
 */
export class PlayerKycStatusWriter implements KycStatusWriter {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
  ) {}

  async setStatus(
    userId: Player['userId'],
    status: KycStatus,
    opts: { actorId: Player['userId'] | null; reason?: string; source: KycStatusSource },
    tx?: unknown,
  ): Promise<void> {
    // Run on the caller's transaction when supplied (atomic with their other writes),
    // else the writer's own db. `tx as DrizzleDb` mirrors the WALLET_COMMANDS port idiom.
    const db = (tx as DrizzleDb | undefined) ?? this.drizzle.db;

    const { rows } = await db.execute<ConditionalUpdateRow>(sql`
      UPDATE player
      SET kyc_status = ${status}
      FROM (SELECT kyc_status FROM player WHERE user_id = ${userId} FOR UPDATE) AS prev
      WHERE player.user_id = ${userId} AND prev.kyc_status <> ${status}
      RETURNING prev.kyc_status AS previous_status
    `);
    const changed = rows[0];

    if (!changed) {
      const [existing] = await db
        .select({ id: player.id })
        .from(player)
        .where(eq(player.userId, userId));
      if (!existing) {
        throw new PlayerNotFoundError(userId);
      }
      return;
    }

    this.events.emit('compliance.kyc.updated', {
      userId,
      actorId: opts.actorId,
      status,
      previousStatus: changed.previous_status,
      reason: opts.reason ?? null,
      source: opts.source,
    });
  }
}
