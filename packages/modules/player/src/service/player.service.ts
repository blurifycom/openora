import { Injectable } from '@nestjs/common';
import { PrismaService } from '@oss/persistence';
import { createAuth } from '@oss/auth';
import type {
  Player,
  PlayerRegistrationPoint,
  PlayerSummary,
  PlayerStatus,
  KycStatus,
} from '../schemas/index.js';

export class PlayerNotFoundError extends Error {
  constructor(playerId: string) {
    super(`Player not found: ${playerId}`);
    this.name = 'PlayerNotFoundError';
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'Admin access required') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

// Shape of the merged Prisma client this service touches at runtime. The
// generated client type is rebuilt by `pnpm regen`; this interface documents
// the subset the player module relies on.
interface PlayerRecord {
  id: string;
  userId: string;
  displayName: string;
  country: string | null;
  currency: string;
  language: string;
  status: string;
  kycStatus: string;
  level: number;
  totalWagered: { toNumber(): number };
  totalDeposits: { toNumber(): number };
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface UserRecord {
  id: string;
  email: string;
  role?: string;
}

interface PrismaWithPlayer {
  player: {
    count(args?: { where?: Record<string, unknown> }): Promise<number>;
    findMany(args?: {
      skip?: number;
      take?: number;
      where?: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
    }): Promise<PlayerRecord[]>;
    findUnique(args: { where: { id: string } }): Promise<PlayerRecord | null>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<PlayerRecord>;
    delete(args: { where: { id: string } }): Promise<PlayerRecord>;
  };
  user: {
    findUnique(args: {
      where: { id: string };
      select?: Record<string, unknown>;
    }): Promise<UserRecord | null>;
    findMany(args?: { where?: Record<string, unknown> }): Promise<UserRecord[]>;
  };
}

function toPlayer(p: PlayerRecord, email: string): Player {
  return {
    id: p.id,
    userId: p.userId,
    displayName: p.displayName,
    email,
    country: p.country,
    currency: p.currency,
    language: p.language,
    status: p.status as PlayerStatus,
    kycStatus: p.kycStatus as KycStatus,
    level: p.level,
    totalWagered: p.totalWagered.toNumber(),
    totalDeposits: p.totalDeposits.toNumber(),
    lastSeenAt: p.lastSeenAt ? p.lastSeenAt.toISOString() : null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class PlayerService {
  private readonly auth: ReturnType<typeof createAuth>;

  constructor(private readonly prisma: PrismaService) {
    this.auth = createAuth({ prisma });
  }

  private get db(): PrismaWithPlayer {
    return this.prisma as unknown as PrismaWithPlayer;
  }

  /**
   * PAM is operator-only. Resolve the session, look up the user's role, and
   * reject non-admins. igaming separates the player realm from operator staff;
   * every PAM route runs through here.
   */
  async assertAdmin(reqHeaders: Record<string, string | string[] | undefined>): Promise<void> {
    const headers = new Headers();
    for (const [k, v] of Object.entries(reqHeaders)) {
      if (v === undefined) continue;
      headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }
    const session = await this.auth.api.getSession({ headers });
    const userId = session?.user?.id;
    if (!userId) throw new ForbiddenError('Authentication required');
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, role: true },
    });
    if (!user || user.role !== 'admin') {
      throw new ForbiddenError();
    }
  }

  private async emailFor(userId: string): Promise<string> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true },
    });
    return user?.email ?? '';
  }

  async list(
    page: number,
    limit: number,
    search?: string,
    status?: PlayerStatus,
  ): Promise<{ players: Player[]; total: number }> {
    const where: Record<string, unknown> = {};
    if (status) where['status'] = status;
    if (search) {
      where['OR'] = [
        { displayName: { contains: search, mode: 'insensitive' } },
        { userId: { contains: search } },
      ];
    }
    const [records, total] = await Promise.all([
      this.db.player.findMany({
        skip: (page - 1) * limit,
        take: limit,
        where,
        orderBy: { createdAt: 'desc' },
      }),
      this.db.player.count({ where }),
    ]);
    const players = await Promise.all(
      records.map(async (r) => toPlayer(r, await this.emailFor(r.userId))),
    );
    return { players, total };
  }

  async get(playerId: string): Promise<Player> {
    const record = await this.db.player.findUnique({ where: { id: playerId } });
    if (!record) throw new PlayerNotFoundError(playerId);
    return toPlayer(record, await this.emailFor(record.userId));
  }

  async update(
    playerId: string,
    data: {
      displayName?: string;
      status?: PlayerStatus;
      kycStatus?: KycStatus;
      level?: number;
    },
  ): Promise<Player> {
    const existing = await this.db.player.findUnique({ where: { id: playerId } });
    if (!existing) throw new PlayerNotFoundError(playerId);
    const patch: Record<string, unknown> = {};
    if (data.displayName !== undefined) patch['displayName'] = data.displayName;
    if (data.status !== undefined) patch['status'] = data.status;
    if (data.kycStatus !== undefined) patch['kycStatus'] = data.kycStatus;
    if (data.level !== undefined) patch['level'] = data.level;
    const record = await this.db.player.update({ where: { id: playerId }, data: patch });
    return toPlayer(record, await this.emailFor(record.userId));
  }

  async remove(playerId: string): Promise<{ success: boolean }> {
    const existing = await this.db.player.findUnique({ where: { id: playerId } });
    if (!existing) throw new PlayerNotFoundError(playerId);
    await this.db.player.delete({ where: { id: playerId } });
    return { success: true };
  }

  /** Daily registration counts over the trailing `days` window (inclusive). */
  async registrationsOverTime(days = 30): Promise<PlayerRegistrationPoint[]> {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (days - 1));
    const records = await this.db.player.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
    });
    // Seed every day in the window with 0 so the chart has no gaps.
    const buckets = new Map<string, number>();
    for (let i = 0; i < days; i++) {
      const d = new Date(since);
      d.setUTCDate(since.getUTCDate() + i);
      buckets.set(toDateKey(d), 0);
    }
    for (const r of records) {
      const key = toDateKey(r.createdAt);
      if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    return [...buckets.entries()].map(([date, count]) => ({ date, count }));
  }

  async summary(): Promise<PlayerSummary> {
    const weekAgo = new Date();
    weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
    const [total, active, newLastWeek, selfExcluded] = await Promise.all([
      this.db.player.count(),
      this.db.player.count({ where: { status: 'active' } }),
      this.db.player.count({ where: { createdAt: { gte: weekAgo } } }),
      this.db.player.count({ where: { status: 'self_excluded' } }),
    ]);
    return { total, active, newLastWeek, selfExcluded };
  }
}
