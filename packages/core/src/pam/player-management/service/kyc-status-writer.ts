import { DrizzleService } from '@blurifycom/core/server';
import type { EventBus, DrizzleDb } from '@blurifycom/core/server';
import type {
  KycStatus,
  KycStatusWriter,
  KycStatusSource,
  Player,
} from '@blurifycom/core/contracts';
import { eq } from 'drizzle-orm';
import { player } from '@blurifycom/core/pam/schema/profile';

/**
 * The single writer of `player.kycStatus` (the KYC_STATUS_WRITER seam). Every status
 * change - admin override, vendor decision, webhook, threshold re-KYC - flows through
 * here, so there is exactly one write path + one `compliance.kyc.updated` emit. Idempotent:
 * a no-change call is a silent no-op (no write, no emit).
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
    const [existing] = await db
      .select({ kycStatus: player.kycStatus })
      .from(player)
      .where(eq(player.userId, userId));
    if (!existing || existing.kycStatus === status) return;

    await db.update(player).set({ kycStatus: status }).where(eq(player.userId, userId));

    this.events.emit('compliance.kyc.updated', {
      userId,
      actorId: opts.actorId,
      status,
      previousStatus: existing.kycStatus,
    });
  }
}
