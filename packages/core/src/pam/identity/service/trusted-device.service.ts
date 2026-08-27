import { type EventBus, DrizzleService, makeNotFoundError } from '@openora/core/server';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { ClientMeta, User } from '@openora/core/contracts';
import { adminTrustedDevice, type AdminTrustedDevice } from '../schema/index.js';
import { deviceHash, describeDevice, trustedDeviceExpiry } from './device-fingerprint.service.js';

export const TrustedDeviceNotFoundError = makeNotFoundError('Trusted device');

export type TrustedDeviceItem = {
  id: string;
  label: string;
  ipAddress: string | null;
  browser: string | null;
  os: string | null;
  lastUsedAt: string;
  expiresAt: string;
  isCurrent: boolean;
};

export type TrustedDeviceServiceDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  trustedDeviceDays: number;
};

/**
 * Server-side half of "trusted device". better-auth issues an opaque trust cookie that
 * nothing can enumerate or revoke; a device skips the second factor only when that
 * cookie AND an unrevoked row here are both present, which is what makes the 30-day
 * window listable, auditable, and revocable by the user or a Super Admin.
 */
export class TrustedDeviceService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly trustedDeviceDays: number;

  constructor({ drizzle, events, trustedDeviceDays }: TrustedDeviceServiceDeps) {
    this.drizzle = drizzle;
    this.events = events;
    this.trustedDeviceDays = trustedDeviceDays;
  }

  async trust(
    userId: User['id'],
    meta: ClientMeta,
  ): Promise<{ id: string; expiresAt: Date } | null> {
    if (this.trustedDeviceDays <= 0) {
      return null;
    }
    const hash = deviceHash(meta.userAgent);
    const { label } = describeDevice(meta.userAgent);
    const expiresAt = trustedDeviceExpiry(this.trustedDeviceDays);
    const [row] = await this.drizzle.db
      .insert(adminTrustedDevice)
      .values({
        userId,
        deviceHash: hash,
        label,
        ipAddress: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [adminTrustedDevice.userId, adminTrustedDevice.deviceHash],
        set: {
          label,
          ipAddress: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          expiresAt,
          lastUsedAt: sql`now()`,
          revokedAt: null,
          revokedBy: null,
        },
      })
      .returning({ id: adminTrustedDevice.id, expiresAt: adminTrustedDevice.expiresAt });

    if (!row) {
      return null;
    }
    this.events.emit('identity.trusted_device.added', {
      userId,
      deviceId: row.id,
      label,
      expiresAt: row.expiresAt.toISOString(),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return row;
  }

  async isTrusted(userId: User['id'], userAgent: string | null): Promise<boolean> {
    const [row] = await this.drizzle.db
      .select({ id: adminTrustedDevice.id })
      .from(adminTrustedDevice)
      .where(this.activeDeviceWhere(userId, deviceHash(userAgent)))
      .limit(1);
    return row !== undefined;
  }

  async list(userId: User['id'], currentUserAgent: string | null): Promise<TrustedDeviceItem[]> {
    const currentHash = deviceHash(currentUserAgent);
    const rows = await this.drizzle.db
      .select()
      .from(adminTrustedDevice)
      .where(and(eq(adminTrustedDevice.userId, userId), isNull(adminTrustedDevice.revokedAt)))
      .orderBy(desc(adminTrustedDevice.lastUsedAt));

    return rows.map((row): TrustedDeviceItem => {
      const { browser, os } = describeDevice(row.userAgent);
      return {
        id: row.id,
        label: row.label,
        ipAddress: row.ipAddress,
        browser,
        os,
        lastUsedAt: row.lastUsedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        isCurrent: row.deviceHash === currentHash,
      };
    });
  }

  async revoke(
    userId: User['id'],
    deviceId: AdminTrustedDevice['id'],
    actorId: User['id'],
    meta?: ClientMeta,
  ): Promise<{ success: true; userAgent: string | null }> {
    const revoked = await this.drizzle.db
      .update(adminTrustedDevice)
      .set({ revokedAt: sql`now()`, revokedBy: actorId })
      .where(
        and(
          eq(adminTrustedDevice.id, deviceId),
          eq(adminTrustedDevice.userId, userId),
          isNull(adminTrustedDevice.revokedAt),
        ),
      )
      .returning({ id: adminTrustedDevice.id, userAgent: adminTrustedDevice.userAgent });

    const [row] = revoked;
    if (!row) {
      throw new TrustedDeviceNotFoundError(deviceId);
    }

    this.events.emit('identity.trusted_device.revoked', {
      userId,
      deviceId,
      actorId,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    return { success: true, userAgent: row.userAgent };
  }

  /**
   * Drops the trust granted to the device a compromised session was riding on, so the
   * forced logout is followed by a full re-authentication instead of a silent skip.
   */
  async revokeForDevice(
    userId: User['id'],
    userAgent: string | null,
    actorId: User['id'],
  ): Promise<void> {
    const revoked = await this.drizzle.db
      .update(adminTrustedDevice)
      .set({ revokedAt: sql`now()`, revokedBy: actorId })
      .where(this.activeDeviceWhere(userId, deviceHash(userAgent)))
      .returning({ id: adminTrustedDevice.id });

    for (const row of revoked) {
      this.events.emit('identity.trusted_device.revoked', {
        userId,
        deviceId: row.id,
        actorId,
        ip: null,
        userAgent,
      });
    }
  }

  private activeDeviceWhere(userId: User['id'], hash: string) {
    return and(
      eq(adminTrustedDevice.userId, userId),
      eq(adminTrustedDevice.deviceHash, hash),
      isNull(adminTrustedDevice.revokedAt),
      gt(adminTrustedDevice.expiresAt, sql`now()`),
    );
  }
}
